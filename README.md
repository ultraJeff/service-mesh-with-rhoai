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

## What's Here

```
manifests/
  istio/                      # Mesh config for RHOAI workloads
    gateway.yaml              # North-south Gateway (istio GatewayClass)
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
  certs/                      # Custom CA for Istio (multi-cluster)
    custom-ca-example.yaml
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
