# Demo Script: OSSM v3 Ambient Mesh for RHOAI

## Pre-Demo Checklist

- [ ] Cluster healthy: `oc get nodes` (3 nodes Ready)
- [ ] Mesh healthy: `oc get istio,istiocni,ztunnel -A` (all Healthy)
- [ ] Models running: `oc get pods -n super-slim-demo` (iris-onnx and phi-4-mini 2/2)
- [ ] Kiali open: `https://kiali-istio-system.apps.tallgeese.ultra.lab`
- [ ] OCP console open: Observe → Service Mesh tab
- [ ] Root CA extracted: `oc get secret mesh-root-ca-secret -n istio-system -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/root-ca.pem`
- [ ] Terminal ready with `oc` and `openssl`

---

## Part 1: The Problem (2 min)

**Talking point:** RHOAI 3.4 ships Istio but it's gateway-only. No pod-to-pod encryption. Model inference traffic is plain HTTP inside the cluster.

### Show the RHOAI gateway is just an ingress controller

```bash
# RHOAI's embedded Istio — gateway only, no mesh
oc get istio -A
# Two Istio CRs: openshift-gateway (RHOAI's, gateway-only) and default (ours, ambient)

# RHOAI's Istio has no sidecar injection, no CNI, no mesh
oc get istio openshift-gateway -n openshift-ingress \
  -o jsonpath='{.spec.values.sidecarInjectorWebhook.enableNamespacesByDefault}'
# Output: false
```

---

## Part 2: The Solution — Ambient Mesh (3 min)

**Talking point:** We layer OSSM v3 ambient mesh on top. No application changes — ztunnel transparently intercepts traffic and encrypts it with mTLS. Zero sidecars.

### Show the ambient mesh components

```bash
# Ambient mesh — ztunnel on every node, istio-cni for traffic interception
oc get pods -n ztunnel
oc get pods -n istio-cni

# The application namespace is enrolled — just two labels
oc get ns super-slim-demo -o jsonpath='{.metadata.labels}' | python3 -m json.tool
# istio.io/dataplane-mode: ambient
# istio.io/use-waypoint: mesh-waypoint

# PeerAuthentication is STRICT — plain HTTP is rejected
oc get peerauthentication -n super-slim-demo
```

### Show the models are serving plain HTTP (ztunnel handles encryption)

```bash
# The model runtime serves plain HTTP on port 8080 — no TLS config in the app
oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp | grep 8080
# LISTEN 0.0.0.0:8080

# But ztunnel ports are also present in the pod's network namespace
oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp | grep -E "15006|15008|15001"
# ztunnel is intercepting all traffic
```

---

## Part 3: Custom CA — Customer-Controlled Trust (3 min)

**Talking point:** All mesh certificates chain to a customer-provided root CA. The gateway cert, the workload SPIFFE certs — everything. One trust anchor you control.

### Show the cert chain

```bash
# The CA chain managed by cert-manager
oc get certificate -n istio-system
# mesh-root-ca, mesh-intermediate-ca, mesh-gateway-cert — all Ready

# Istio's CA uses our intermediate CA
oc get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\.pem}' \
  | base64 -d | openssl x509 -noout -subject -issuer
# subject=O=tallgeese.ultra.lab, CN=Mesh Root CA
# issuer=O=tallgeese.ultra.lab, CN=Mesh Root CA

# The gateway cert is signed by the same chain
echo | openssl s_client -connect iris-onnx.apps.tallgeese.ultra.lab:443 \
  -showcerts 2>/dev/null | openssl x509 -noout -subject -issuer
# subject=CN=mesh-gateway.apps.tallgeese.ultra.lab
# issuer=O=tallgeese.ultra.lab, CN=Mesh Intermediate CA
```

### Inference with cert verification

```bash
# The client verifies the cert against our root CA
curl --cacert /tmp/root-ca.pem \
  https://iris-onnx.apps.tallgeese.ultra.lab/v2/models/iris-onnx/infer \
  -H "Content-Type: application/json" \
  -d '{"inputs":[{"name":"input","shape":[1,4],"datatype":"FP32","data":[5.1,3.5,1.4,0.2]}]}'
```

---

## Part 4: Mesh Gateway — Encrypted North-South (3 min)

**Talking point:** External traffic enters through our mesh gateway, not a direct Route. The gateway terminates TLS with the custom CA cert, then speaks mTLS to backends via ztunnel. Every hop encrypted.

### Show the traffic path

```bash
# The mesh gateway — our Envoy pod in istio-system
oc get gateway mesh-gateway -n istio-system
oc get pods -n istio-system -l istio.io/gateway-name=mesh-gateway

# HTTPRoutes attach models to the gateway
oc get httproute -n super-slim-demo

# OCP passthrough Routes forward raw TLS to the gateway
oc get route -n istio-system | grep mesh-gateway
```

### Prove mTLS end-to-end with ztunnel logs

```bash
# Generate traffic
curl --cacert /tmp/root-ca.pem \
  https://iris-onnx.apps.tallgeese.ultra.lab/v2/models/iris-onnx -s -o /dev/null

# Ztunnel access log proves mTLS — SPIFFE identities on both sides
oc logs -n ztunnel -l app=ztunnel --since=10s | grep "iris-onnx"
# src.identity="spiffe://cluster.local/ns/istio-system/sa/mesh-gateway-istio"
# dst.identity="spiffe://cluster.local/ns/super-slim-demo/sa/default"
# dst.hbone_addr=10.x.x.x:8080 — HBONE tunnel, not direct
```

---

## Part 5: Traffic Management — L7 Policy (3 min)

**Talking point:** Ztunnel handles L4 mTLS for free. For L7 policies — authorization, retries, timeouts — the waypoint proxy adds Envoy-powered policy enforcement.

### Show the waypoint proxy

```bash
# Waypoint deployed per-namespace for L7 policy
oc get gateway mesh-waypoint -n super-slim-demo
oc get pods -n super-slim-demo -l gateway.networking.k8s.io/gateway-name=mesh-waypoint
```

### Demo: AuthorizationPolicy (restrict who can call the model)

```bash
# Only allow the mesh gateway to call iris-onnx
oc apply -f - <<EOF
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: iris-allow-gateway-only
  namespace: super-slim-demo
spec:
  targetRefs:
    - kind: Service
      group: ""
      name: iris-onnx-predictor
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/istio-system/sa/mesh-gateway-istio"
EOF

# This still works (mesh gateway is allowed)
curl --cacert /tmp/root-ca.pem \
  https://iris-onnx.apps.tallgeese.ultra.lab/v2/models/iris-onnx -s | head -1

# But pod-to-pod from the notebook is denied
oc exec -n super-slim-demo test-notebook-0 -- \
  curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  http://iris-onnx-predictor.super-slim-demo.svc:80/v2/models/iris-onnx
# 403 Forbidden

# Clean up
oc delete authorizationpolicy iris-allow-gateway-only -n super-slim-demo
```

### Demo: Retry policy

```bash
# TODO: Add retry policy example using HTTPRoute retry filter
# or Istio VirtualService retries once the waypoint is routing traffic
```

---

## Part 6: Observability (2 min)

**Talking point:** Kiali provides the mesh topology view. You can see traffic flow, mTLS status, and trace requests end-to-end.

### Show Kiali

- Open `https://kiali-istio-system.apps.tallgeese.ultra.lab`
- Navigate to Graph → select `super-slim-demo` namespace
- Show traffic flow from mesh-gateway to model pods
- Show the lock icon (mTLS enabled)
- Click a service → show SPIFFE identity in the sidebar

### Show the OCP Console mesh tab

- OpenShift Console → Observe → Service Mesh
- Show the mesh topology

---

## Part 7: Multi-Cluster Preview (1 min)

**Talking point:** The custom CA is the foundation for multi-cluster federation. Same root CA on both clusters = cross-cluster mTLS. We'll demonstrate this on the new cloud clusters next week.

```bash
# The root CA cert that would be shared across clusters
oc get secret mesh-root-ca-secret -n istio-system \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject
# O=tallgeese.ultra.lab, CN=Mesh Root CA

# Deploy the same cacerts secret to the second cluster's istio-system
# → all workload SPIFFE certs chain to the same root
# → cross-cluster mTLS "just works"
```

---

## Appendix: Quick Recovery Commands

```bash
# If models are down after a restart
oc rollout restart deployment iris-onnx-predictor phi-4-mini-predictor -n super-slim-demo

# If ztunnel needs restart
oc rollout restart daemonset ztunnel -n ztunnel

# If the mesh gateway needs restart
oc rollout restart deployment mesh-gateway-istio -n istio-system

# Regenerate cacerts from cert-manager secrets
bash scripts/create-istio-cacerts.sh
```
