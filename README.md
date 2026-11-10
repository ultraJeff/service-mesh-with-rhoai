# Service Mesh with RHOAI

End-to-end mTLS for Red Hat OpenShift AI using OSSM v3 ambient mesh — enrolling RHOAI workloads in the mesh for automatic L4 mTLS (via ztunnel) and L7 policy (via waypoint proxies).

## Why

RHOAI 3.4 ships an embedded Istio that functions only as a Gateway API controller:
- No sidecar injection, no pod-to-pod mTLS
- Cannot be extended (Ingress Operator reverts changes)
- vLLM and notebook traffic is plain HTTP on backend hops
- Cannot federate with other meshes for multi-cluster

## Architecture

The OSSM v3 ambient mesh (deployed by the [ossm-3-demo](https://github.com/ultraJeff/ossm-3-demo) ArgoCD app) runs alongside RHOAI's embedded Istio. Both coexist — the RHOAI GatewayConfig cannot be suppressed (the DSCI operator recreates it immediately).

```
                    ┌─────────────────────────────────────────────────┐
                    │              OSSM v3 Ambient Mesh               │
                    │         (ztunnel L4 + waypoint L7)              │
                    │                                                 │
  Client ──TLS──►   OpenShift Route ──► Model Pod (ztunnel mTLS)     │
                    │                                                 │
                    │  Pod ──mTLS──► Pod (east-west, via ztunnel)     │
                    │                                                 │
                    │  Waypoint proxy: L7 policy, AuthZ, retries      │
                    └─────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────────┐
                    │         RHOAI Embedded Istio (unchanged)        │
                    │   data-science-gateway in openshift-ingress     │
                    │   Dashboard + notebook HTTPRoutes still work    │
                    └─────────────────────────────────────────────────┘
```

## Current Status

- OSSM v3.3.3 deployed via ArgoCD (ossm-3-demo integrated overlay)
- Ambient mesh healthy: istiod, istio-cni, ztunnel running on all nodes
- `ossm-ai-models` namespace enrolled in ambient mesh
- Waypoint proxy deployed for L7 policy
- RHOAI gateway coexists (can't be suppressed)

### Key Findings

1. **DSCI operator recreates GatewayConfig** — deleting it has no effect, it comes back in seconds
2. **Two Istio CRs coexist** — `openshift-gateway` (RHOAI, v1.26.2) and `default` (ours, ambient, v1.28.5)
3. **Ingress Operator owns the OSSM subscription** — sets Manual approval; ArgoCD can't override
4. **ArgoCD SSA breaks on the Istio CRD** — must use `Replace=true` instead of `ServerSideApply=true`
5. **Pods need restart after CNI install** — ztunnel can't intercept traffic until istio-cni sets up iptables rules in the pod's netns

## Prerequisites

- OpenShift 4.19+ cluster
- RHOAI 3.4 operator installed
- OSSM v3 operator installed (servicemeshoperator3) — managed by ArgoCD via ossm-3-demo
- cert-manager operator installed
- The `service-mesh` ArgoCD Application deployed from [openshift-bootstrap-gitops](https://github.com/ultraJeff/openshift-bootstrap-gitops)
- The AI models gateway stack from [ossm-3-demo](https://github.com/ultraJeff/ossm-3-demo) (see below)

## Dependency on ossm-3-demo

The north-south gateway for the model endpoints lives in **ossm-3-demo**, not here. `resources/rhoai/overlays/models/` in that repo defines:

- `istio-ingress/ai-models-gateway` (the Gateway)
- the HTTPRoutes for `iris-onnx` and `phi4-mesh`
- the passthrough OpenShift Routes
- the `istio-system/ai-models-gateway-tls` ReferenceGrant

This repo still owns the certificate chain the gateway serves: the CA, the intermediate CA Issuer, and the `mesh-gateway-cert` Certificate in `manifests/certs/`. The gateway reads the resulting `istio-system/mesh-gateway-tls` secret across namespaces through the ReferenceGrant.

Keep the two in step:

- If you add a hostname to an HTTPRoute in ossm-3-demo, add it to `dnsNames` in `manifests/certs/gateway-tls-cert.yaml`.
- If you rename or move the Certificate or its secret, update the Gateway and the ReferenceGrant in ossm-3-demo.
- Don't copy `mesh-gateway-tls` into `istio-ingress`. cert-manager only renews the secret it owns. A copy made this way expired in August 2026.

ArgoCD manages both halves from [openshift-bootstrap-gitops](https://github.com/ultraJeff/openshift-bootstrap-gitops):

- The `ai-models-gateway-certs` app deploys `manifests/certs/` from this repo.
- The `ai-models-gateway` app deploys `resources/rhoai/gateway/` from ossm-3-demo.

The rest of `manifests/` is not synced by ArgoCD. Parts of it overlap with the `service-mesh` app (Istio, IstioCNI, ZTunnel, Kiali, the operator Subscriptions), so don't point an app at the whole directory.

### The CA chain is also Istio's mesh CA

`istio-system/cacerts` is built from `mesh-intermediate-ca-secret` by `scripts/create-istio-cacerts.sh`, so istiod signs every workload certificate with this intermediate CA. Two consequences:

- **Changing the CA Certificates reissues the CA.** That includes their `subject.organizations`. Plan it as a CA rotation: rerun the script, restart istiod and ztunnel, and reissue the gateway cert. Don't change the CA in a routine sync.
- **`cacerts` is a copy, and it will not follow a renewal.** The intermediate CA is valid until 2031, and cert-manager renews it a year early, in 2030. When that happens, rerun `create-istio-cacerts.sh`, or the mesh keeps signing with the old CA.

## What's Here

```
manifests/
  istio/                      # Mesh config for RHOAI workloads
    waypoint.yaml             # Waypoint proxy for L7 policy (istio-waypoint)
    peer-authentication.yaml  # PERMISSIVE mTLS (RHOAI gateway is outside mesh)
  rhoai/                      # RHOAI config
    dsci.yaml                 # DSCInitialization
    dsc.yaml                  # DataScienceCluster (Headed services for mesh routing)
    namespace.yaml            # Demo namespace with ambient enrollment labels
  models/                     # Model serving manifests
    vllm-serving-runtime.yaml
    phi4-inference-service.yaml
    mlserver-serving-runtime.yaml
    iris-inference-service.yaml
  certs/                      # Custom CA chain and gateway certificate
    ca-chain.yaml             # Root and intermediate CA, intermediate CA Issuer
    gateway-tls-cert.yaml     # Certificate served by ai-models-gateway (ossm-3-demo)
```

## Applying

```bash
# Enroll namespace in ambient mesh
oc apply -f manifests/rhoai/namespace.yaml

# Deploy waypoint proxy and PeerAuthentication
oc apply -f manifests/istio/waypoint.yaml
oc apply -f manifests/istio/peer-authentication.yaml

# Restart workloads to pick up CNI rules
oc rollout restart deployment -n ossm-ai-models

# Deploy models (if not already running)
oc apply -f manifests/rhoai/dsc.yaml
oc apply -f manifests/models/
```

## PeerAuthentication Modes

- **PERMISSIVE** (current): Allows both plain and mTLS traffic. Required because the RHOAI gateway (in `openshift-ingress`) is not enrolled in the ambient mesh.
- **STRICT**: Rejects all non-mTLS traffic. Use only when all traffic sources (including north-south gateways) are within the mesh.

## What Doesn't Work

- Suppressing the RHOAI-managed gateway (DSCI recreates GatewayConfig)
- Changing the OSSM subscription via ArgoCD (Ingress Operator owns it)
- ArgoCD ServerSideApply on the Istio CRD (field pruning conflict between the two Istio CRs)
