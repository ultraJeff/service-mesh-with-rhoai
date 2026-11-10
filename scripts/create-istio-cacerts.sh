#!/bin/bash
set -euo pipefail

# Creates the 'cacerts' secret in istio-system from cert-manager-managed CA secrets.
# Istio expects specific key names (ca-cert.pem, ca-key.pem, root-cert.pem, cert-chain.pem)
# while cert-manager uses tls.crt/tls.key/ca.crt.

NS="istio-system"

echo "Extracting certs from cert-manager secrets..."

ROOT_CERT=$(oc get secret mesh-root-ca-secret -n "$NS" -o jsonpath='{.data.tls\.crt}' | base64 -d)
CA_CERT=$(oc get secret mesh-intermediate-ca-secret -n "$NS" -o jsonpath='{.data.tls\.crt}' | base64 -d)
CA_KEY=$(oc get secret mesh-intermediate-ca-secret -n "$NS" -o jsonpath='{.data.tls\.key}' | base64 -d)
CERT_CHAIN="${CA_CERT}
${ROOT_CERT}"

echo "Root CA subject:         $(echo "$ROOT_CERT" | openssl x509 -noout -subject 2>/dev/null)"
echo "Intermediate CA subject: $(echo "$CA_CERT" | openssl x509 -noout -subject 2>/dev/null)"

oc delete secret cacerts -n "$NS" 2>/dev/null && echo "Deleted existing cacerts secret" || true

oc create secret generic cacerts -n "$NS" \
  --from-literal=ca-cert.pem="$CA_CERT" \
  --from-literal=ca-key.pem="$CA_KEY" \
  --from-literal=root-cert.pem="$ROOT_CERT" \
  --from-literal=cert-chain.pem="$CERT_CHAIN"

echo "Created cacerts secret in $NS"
echo ""
echo "Restarting istiod..."
oc rollout restart deployment istiod -n "$NS"
oc rollout status deployment istiod -n "$NS" --timeout=60s

echo "Restarting ztunnel..."
oc rollout restart daemonset ztunnel -n ztunnel
oc rollout status daemonset ztunnel -n ztunnel --timeout=120s

echo "Restarting workloads in ossm-ai-models..."
oc delete pod -n ossm-ai-models -l gateway.networking.k8s.io/gateway-name=mesh-waypoint
oc rollout restart deployment iris-onnx-predictor phi-4-mini-predictor -n ossm-ai-models 2>/dev/null || true

echo ""
echo "Done. All mesh components now use the custom CA."
echo "Verify: oc get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\.pem}' | base64 -d | openssl x509 -noout -subject"
