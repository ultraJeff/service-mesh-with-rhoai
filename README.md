# Service Mesh with RHOAI

End-to-end mTLS for Red Hat OpenShift AI using a unified OSSM v3 service mesh — replacing RHOAI's built-in gateway-only Istio with a full mesh that handles both north-south (gateway) and east-west (pod-to-pod) traffic under one trust domain.

## Why

RHOAI 3.4 ships an embedded Istio that functions only as a Gateway API controller. It cannot:
- Inject sidecars into application pods
- Provide pod-to-pod mTLS
- Be extended for mesh capabilities (the Ingress Operator reverts changes)
- Federate with other meshes for multi-cluster

Creating a separate mesh Istio creates a second trust domain — the gateway can't authenticate to mesh-enrolled backends, breaking the north-south path.

The solution: disable RHOAI's auto-managed gateway and replace it with a single OSSM v3 Istio that does everything — gateway routing, sidecar mTLS, and (eventually) multi-cluster federation.

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │              Unified OSSM v3 Istio              │
                    │         (gateway + mesh, one CA/trust)          │
                    │                                                 │
  Client ──TLS──►  │  Gateway ──mTLS──► Model Pod (sidecar)          │
                    │     │                                           │
                    │     └──mTLS──► Dashboard Pod (sidecar)          │
                    │     │                                           │
                    │     └──mTLS──► Notebook Pod (sidecar)           │
                    │                                                 │
                    │  Pod ──mTLS──► Pod (east-west, automatic)       │
                    └─────────────────────────────────────────────────┘
```

## Current Status

This is a work-in-progress. Key questions to resolve:

1. **Can we disable the RHOAI-managed gateway?** Deleting the GatewayClass or GatewayConfig — does the operator fight us?
2. **Does the dashboard work with a custom gateway?** The HTTPRoutes target `data-science-gateway` by name — if we create our own with the same name, do they attach?
3. **Does the odh-model-controller work?** It creates Routes for models — will it work with our mesh gateway instead?
4. **Multi-cluster federation** — can we federate the unified Istio with another cluster's mesh?

## Prerequisites

- OpenShift 4.19+ cluster
- RHOAI 3.4 operator installed
- OSSM v3 operator installed (servicemeshoperator3)
- cert-manager operator installed

## What's Here

```
manifests/
  istio/                    # Unified Istio CR + mesh config
    namespace.yaml          # istio-system namespace
    istio.yaml              # Istio CR with gateway + mesh capabilities
    gateway.yaml            # Gateway replacing RHOAI's data-science-gateway
    peer-authentication.yaml # STRICT mTLS for enrolled namespaces
  rhoai/                    # RHOAI config (gateway disabled)
    dsci.yaml               # DSCInitialization
    dsc.yaml                # DataScienceCluster
    namespace.yaml          # Demo namespace with sidecar injection label
  models/                   # Model serving manifests
    vllm-serving-runtime.yaml
    phi4-inference-service.yaml
    mlserver-serving-runtime.yaml
    iris-inference-service.yaml
  certs/                    # cert-manager resources (if needed beyond mesh certs)
    cert-manager-mtls.yaml
```

## Key Findings from rhoai-super-slim

These findings inform our approach (see [rhoai-super-slim](../rhoai-super-slim) for full details):

### RHOAI 3.4 TLS Status (Out of the Box)

| Hop | Dashboard | Model Serving | Notebooks |
|-----|-----------|---------------|-----------|
| Edge (client → router) | TLS 1.3 | TLS 1.3 | TLS 1.3 |
| Router → Gateway | TLS (reencrypt) | N/A (direct Route) | TLS (reencrypt) |
| Gateway → Backend | TLS (port 8443) | **Plain HTTP** | **Plain HTTP** |
| Pod-to-pod | None | None | None |

### RHOAI's Embedded Istio (what we're replacing)

- Lives in `openshift-ingress`, owned by the Ingress Operator via GatewayClass
- `sidecarInjectorWebhook.enableNamespacesByDefault: false`
- `cni.enabled: false`
- No discovery of application namespaces
- Creates: `GatewayConfig` CR, `data-science-gateway` Gateway, `data-science-tls-rule` DestinationRule, `kube-auth-proxy` pods

### Proven Approaches

- **vLLM native TLS**: `--ssl-certfile`, `--ssl-keyfile`, `--ssl-cert-reqs=2` with cert-manager client certs — works, enforces mTLS
- **MLServer TLS**: monkey-patch `Settings._custom_rest_server_settings` to inject uvicorn SSL config — works for ONNX models
- **Both runtimes**: uvicorn accepts HTTP+HTTPS on same socket; `ssl_cert_reqs=2` is the only way to reject plain HTTP
- **Service serving certs**: OpenShift auto-provisions TLS certs for services; key usage is server-only (no client auth)
- **Headless vs Headed**: `rawDeploymentServiceConfig: Headed` gives ClusterIP; `Headless` breaks reencrypt routes

### What Doesn't Work

- Patching the RHOAI-managed Gateway (Ingress Operator reverts)
- Reencrypt Routes to vLLM/MLServer (uvicorn protocol mismatch → 502)
- OpenShift service serving certs as client certs (server auth key usage only)
- Two separate Istio trust domains (gateway can't auth to mesh backends)

## Approach

### Phase 1: Disable RHOAI Gateway

Investigate how to suppress the auto-managed gateway:
- Delete or modify the `GatewayClass` (`data-science-gateway-class`)
- Or modify the `GatewayConfig` to disable it
- Monitor if the RHOAI operator recreates it

### Phase 2: Deploy Unified OSSM v3 Istio

Create a standalone Istio CR in `istio-system` with:
- Gateway API enabled (`PILOT_ENABLE_GATEWAY_API: true`)
- Sidecar injection enabled
- Discovery selectors for application namespaces
- PeerAuthentication STRICT

### Phase 3: Create Replacement Gateway

Deploy a Gateway under the unified Istio that:
- Uses `allowedRoutes.namespaces.from: All`
- Has HTTPS listener with proper TLS cert
- Is named `data-science-gateway` in `openshift-ingress` so existing HTTPRoutes attach

### Phase 4: Enable Mesh for RHOAI Workloads

- Label application namespaces for sidecar injection
- Verify the dashboard HTTPRoute works through our gateway
- Deploy models and verify end-to-end mTLS
- Verify notebook traffic is encrypted

### Phase 5: Multi-Cluster Federation

- Shared root CA across clusters
- Cross-cluster service discovery
- Multi-cluster Gateway API
