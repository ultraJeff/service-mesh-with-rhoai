# OSSM v3 Ambient Mesh for RHOAI 3.4 — Architecture & Security Report

## Environment

| Component | Version |
|-----------|---------|
| OpenShift | 4.20.22 (Kubernetes 1.33.10) |
| RHOAI | 3.4.0 |
| OSSM (Sail Operator) | 3.3.3 |
| Istio (data plane) | 1.28.5 |
| Mesh profile | Ambient (ztunnel + waypoint) |
| CNI | OVN-Kubernetes with `routingViaHost: true` |
| Cluster | tallgeese — 3-node compact (tallgeese/sandrock/epyon) |

## Problem Statement

RHOAI 3.4 ships an embedded Istio instance that functions **only as a Gateway API ingress controller**. It cannot provide pod-to-pod mTLS, sidecar injection, or any east-west security. Out of the box:

| Traffic Hop | Dashboard | Model Serving (vLLM) | Notebooks |
|-------------|-----------|---------------------|-----------|
| Client → OCP Router | TLS 1.3 | TLS 1.3 | TLS 1.3 |
| Router → RHOAI Gateway | TLS (reencrypt) | N/A (direct Route) | TLS (reencrypt) |
| Gateway → Backend Pod | TLS (port 8443) | **Plain HTTP** | **Plain HTTP** |
| Pod → Pod (east-west) | **None** | **None** | **None** |

The backend hops for model serving and notebooks are unencrypted. There is no mutual authentication between workloads.

## Solution: Ambient Mesh with Custom CA and Mesh Gateway

We deploy OSSM v3 in **ambient mode** alongside RHOAI's embedded Istio, with a **customer-provided CA chain** and a **mesh-native north-south gateway**. The two Istio control planes coexist — RHOAI's gateway cannot be suppressed (the DSCI operator recreates it immediately), but our mesh handles all security-sensitive traffic.

### Custom CA Chain

All mesh certificates — both the external-facing gateway TLS cert and the internal SPIFFE workload identity certs — chain to a single customer-controlled root CA, managed by cert-manager:

```
  Mesh Root CA  (self-signed, 10yr, O=tallgeese.ultra.lab)
       │
       ▼
  Mesh Intermediate CA  (signed by root, 5yr)
       │
       ├──► Gateway TLS cert  (mesh-gateway.apps.tallgeese.ultra.lab, 90d)
       │    Used by: mesh-gateway Envoy for external TLS termination
       │
       └──► Istio cacerts  (ca-cert.pem / ca-key.pem / root-cert.pem)
            Used by: istiod to sign SPIFFE workload identity certs
            All ztunnel HBONE tunnels use certs from this chain
```

### Architecture Diagram

```
                      ┌───────────────────────────────────────────────┐
                      │           Custom CA Chain                     │
                      │         (cert-manager managed)                │
                      │                                               │
                      │  Mesh Root CA (O=tallgeese.ultra.lab)         │
                      │       │                                       │
                      │       ▼                                       │
                      │  Mesh Intermediate CA                         │
                      │       │                                       │
                      │  ┌────┴───────────────┐                       │
                      │  ▼                    ▼                       │
                      │  Gateway TLS     Istio cacerts                │
                      │  (external)      (SPIFFE SVIDs)               │
                      └───────────────────────────────────────────────┘

 ═══════════════════════════════════════════════════════════════════════
  NORTH-SOUTH: MODEL SERVING (through mesh gateway)
 ═══════════════════════════════════════════════════════════════════════

 Client
   │
   │ TLS (SNI: iris-onnx.apps.tallgeese.ultra.lab)
   ▼
 ┌──────────────────────┐
 │ OCP Router           │  Passthrough Route — raw TLS forwarded,
 │ (openshift-ingress)  │  no termination, SNI-based routing
 └──────────┬───────────┘
            │ TLS (passthrough)
            ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ Mesh Gateway (istio-system)                                    │
 │ GatewayClass: istio                                            │
 │ Deployment: mesh-gateway-istio                                 │
 │                                                                │
 │ Terminates TLS using custom CA-signed cert:                    │
 │   Subject: CN=mesh-gateway.apps.tallgeese.ultra.lab            │
 │   Issuer:  O=tallgeese.ultra.lab, CN=Mesh Intermediate CA      │
 │                                                                │
 │ SPIFFE identity for mTLS to backends:                          │
 │   spiffe://cluster.local/ns/istio-system/sa/mesh-gateway-istio │
 │                                                                │
 │ HTTPRoutes attached:                                           │
 │   iris-onnx.apps.tallgeese.ultra.lab  → iris-onnx:80           │
 │   phi-4-mini.apps.tallgeese.ultra.lab → phi-4-mini:80          │
 └──────────┬─────────────────────────────────────────────────────┘
            │
            │ HBONE mTLS (HTTP/2 CONNECT over mTLS, port 15008)
            │ Certs signed by Mesh Intermediate CA
            │ src: spiffe://.../sa/mesh-gateway-istio
            │ dst: spiffe://.../sa/default
            ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ super-slim-demo namespace                                      │
 │ Labels: istio.io/dataplane-mode: ambient                       │
 │         istio.io/use-waypoint: mesh-waypoint                   │
 │ PeerAuthentication: STRICT                                     │
 │                                                                │
 │ ┌────────────────────────────────────────────────────────────┐ │
 │ │ ztunnel (DaemonSet, per-node)                              │ │
 │ │ Intercepts all pod traffic via iptables + istio-cni        │ │
 │ │ HBONE tunnels with SPIFFE certs from custom CA             │ │
 │ ├────────────────────────────────────────────────────────────┤ │
 │ │                                                            │ │
 │ │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐   │ │
 │ │  │ iris-onnx     │  │ phi-4-mini   │  │ test-notebook  │  │ │
 │ │  │ (MLServer)    │  │ (vLLM)       │  │ (JupyterLab)  │  │ │
 │ │  │ plain HTTP    │  │ plain HTTP   │  │ plain HTTP    │  │ │
 │ │  │ port 8080     │  │ port 8080    │  │ port 8888     │  │ │
 │ │  └──────────────┘  └──────────────┘  └───────────────┘   │ │
 │ │         ▲                ▲                  ▲             │ │
 │ │         └───── HBONE mTLS (automatic) ─────┘             │ │
 │ │                                                           │ │
 │ │  ┌──────────────────┐                                     │ │
 │ │  │ mesh-waypoint    │  L7 policy enforcement              │ │
 │ │  │ (Envoy proxy)    │  AuthorizationPolicy, retries       │ │
 │ │  │ istio-waypoint   │                                     │ │
 │ │  └──────────────────┘                                     │ │
 │ └────────────────────────────────────────────────────────────┘ │
 └────────────────────────────────────────────────────────────────┘

 ═══════════════════════════════════════════════════════════════════════
  NORTH-SOUTH: DASHBOARD + NOTEBOOKS (RHOAI gateway, unchanged)
 ═══════════════════════════════════════════════════════════════════════

 Client
   │
   │ TLS (rh-ai.apps.tallgeese.ultra.lab)
   ▼
 ┌──────────────────────┐
 │ OCP Router           │
 └──────────┬───────────┘
            ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ RHOAI Gateway (openshift-ingress)                              │
 │ GatewayClass: data-science-gateway-class                       │
 │ Controller: openshift.io/gateway-controller/v1                 │
 │                                                                │
 │ data-science-gateway ──► kube-auth-proxy (OAuth)               │
 │                                 │                              │
 │ HTTPRoutes:                     │                              │
 │   /              → dashboard    │                              │
 │   /notebook/...  → notebook  ◄──┘                              │
 └────────────────────────────────────────────────────────────────┘
            │
            │ (ztunnel provides mTLS on this hop too —
            │  traffic enters the pod's netns where
            │  ztunnel intercepts it)
            ▼
      Dashboard / Notebook pods

 ═══════════════════════════════════════════════════════════════════════
  EAST-WEST: POD-TO-POD (automatic, zero config)
 ═══════════════════════════════════════════════════════════════════════

 ┌────────────┐    HBONE mTLS (port 15008)     ┌────────────┐
 │ Pod A      │ ─────────────────────────────►  │ Pod B      │
 │ (any app)  │    ztunnel ◄────► ztunnel       │ (any app)  │
 │ plain HTTP │    SPIFFE certs from            │ plain HTTP │
 └────────────┘    custom CA chain              └────────────┘

 ═══════════════════════════════════════════════════════════════════════
  CONTROL PLANE
 ═══════════════════════════════════════════════════════════════════════

 ┌────────────────────────────────────────────────────────────────┐
 │ istio-system                                                   │
 │                                                                │
 │  istiod           Mesh Gateway      Kiali                      │
 │  (xDS config,     (Envoy, TLS       (mesh UI,                  │
 │   cert signing,    termination,      topology)                 │
 │   SPIFFE SVIDs)    north-south)                                │
 │                                                                │
 │  Istio CA: cacerts secret                                      │
 │  ├─ ca-cert.pem   = Mesh Intermediate CA cert                  │
 │  ├─ ca-key.pem    = Mesh Intermediate CA key                   │
 │  ├─ root-cert.pem = Mesh Root CA cert (trust anchor)           │
 │  └─ cert-chain.pem = Intermediate + Root                       │
 └────────────────────────────────────────────────────────────────┘
 ┌───────────────────────┐  ┌───────────────────────┐
 │ istio-cni (DaemonSet) │  │ ztunnel (DaemonSet)   │
 │ iptables rules in     │  │ L4 mTLS, HBONE        │
 │ each pod's netns      │  │ tunnels, SPIFFE certs  │
 └───────────────────────┘  └───────────────────────┘
```

## Security Configuration Deep Dive

### 1. Custom CA Integration

The mesh uses a customer-provided CA chain managed by cert-manager. This replaces Istio's default self-signed CA with a chain the customer controls:

```yaml
# cert-manager creates the chain automatically:
ClusterIssuer/mesh-selfsigned        # bootstrap (self-signed)
  → Certificate/mesh-root-ca          # Root CA (10yr TTL)
    → Issuer/mesh-root-ca-issuer
      → Certificate/mesh-intermediate-ca   # Intermediate CA (5yr TTL)
        → Issuer/mesh-intermediate-ca-issuer
          → Certificate/mesh-gateway-cert  # Gateway TLS (90d TTL)
```

The Istio `cacerts` secret is constructed from the cert-manager outputs via `scripts/create-istio-cacerts.sh`, which maps cert-manager's key names (`tls.crt`/`tls.key`) to Istio's expected names (`ca-cert.pem`/`ca-key.pem`/`root-cert.pem`/`cert-chain.pem`).

**Why this matters for multi-cluster:** All clusters sharing the same root CA can cross-authenticate workload SPIFFE identities. Deploy the same `cacerts` secret (with the same root CA) to each cluster's `istio-system` namespace.

### 2. Identity: SPIFFE/SPIRE-Compatible Workload IDs

Every workload in the ambient mesh receives a **SPIFFE Verifiable Identity Document (SVID)** certificate signed by the Mesh Intermediate CA. The identity format:

```
spiffe://cluster.local/ns/super-slim-demo/sa/default
         └─ trust domain   └─ namespace          └─ service account
```

These certificates are:
- Automatically rotated (24h TTL by default)
- Issued via the Kubernetes TokenReview API (workload proves its identity via its service account token)
- Never touch the application — ztunnel holds and presents them on behalf of the pod
- Signed by the customer-controlled Mesh Intermediate CA, chaining to the Mesh Root CA

### 3. Transport: HBONE (HTTP-Based Overlay Network Encapsulation)

Pod-to-pod traffic in the ambient mesh is tunneled through **HBONE** — HTTP/2 CONNECT over mTLS:

| Property | Sidecar Mode | Ambient Mode |
|----------|-------------|-------------|
| Encryption agent | Envoy sidecar per pod | ztunnel DaemonSet per node |
| Tunnel protocol | Raw mTLS | HBONE (HTTP/2 CONNECT over mTLS) |
| Port | App port (rewritten) | 15008 (dedicated HBONE port) |
| Pod modification | Yes (sidecar injected) | No (transparent interception) |
| Certificate holder | Sidecar container | ztunnel (node-level) |

The ztunnel intercepts traffic using iptables rules injected into each pod's network namespace by the **istio-cni** DaemonSet:

```
# Inbound: redirect all TCP (except HBONE 15008) to ztunnel passthrough
-A ISTIO_PRERT ! -d 127.0.0.1/32 -p tcp ! --dport 15008 -j REDIRECT --to-ports 15006

# Outbound: redirect all TCP to ztunnel outbound
-A ISTIO_OUTPUT ! -d 127.0.0.1/32 -p tcp -j REDIRECT --to-ports 15001

# Exempt kubelet health probes (SNAT address)
-A ISTIO_PRERT -s 169.254.7.127/32 -p tcp -j ACCEPT
-A ISTIO_OUTPUT -d 169.254.7.127/32 -p tcp -j ACCEPT
```

### 4. Mesh Gateway: North-South with Custom CA

The mesh gateway terminates external TLS using a cert signed by the custom CA chain, then routes to backend pods via HBONE mTLS. This closes the north-south encryption gap that existed with direct OCP Routes:

| | Before (OCP Route) | After (Mesh Gateway) |
|---|---|---|
| External TLS | OCP wildcard cert | Custom CA cert |
| Router → Backend | **Plain HTTP** | **Passthrough** (TLS preserved) |
| Gateway → Pod | N/A | **HBONE mTLS** (SPIFFE) |
| Client sees | OCP wildcard cert | Custom CA cert chain |

The gateway is exposed via OCP **passthrough** Routes (one per hostname). The OCP Router uses SNI to match the hostname and forwards raw TLS to the mesh gateway, which terminates it. The client can verify the cert chain:

```bash
$ openssl s_client -connect iris-onnx.apps.tallgeese.ultra.lab:443
subject=CN=mesh-gateway.apps.tallgeese.ultra.lab
issuer=O=tallgeese.ultra.lab, CN=Mesh Intermediate CA
```

### 5. PeerAuthentication: STRICT Mode

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: super-slim-demo
spec:
  mtls:
    mode: STRICT
```

With the mesh gateway handling all north-south model traffic, **STRICT mTLS** is now possible. All traffic to pods in the namespace must present a valid SPIFFE certificate signed by the mesh CA. Plain HTTP is rejected.

| Mode | East-west (pod↔pod) | North-south (gateway→pod) | Trade-off |
|------|--------------------|--------------------------|----|
| PERMISSIVE | mTLS (automatic) | Plain TCP (accepted) | Defense in depth |
| **STRICT** | **mTLS (enforced)** | **mTLS (enforced)** | **Zero trust** |

### 6. Waypoint Proxy: L7 Policy Enforcement

The waypoint proxy provides L7 capabilities on top of ztunnel's L4 mTLS:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: mesh-waypoint
  namespace: super-slim-demo
  labels:
    istio.io/waypoint-for: service
spec:
  gatewayClassName: istio-waypoint
  listeners:
    - name: mesh
      port: 15008
      protocol: HBONE
```

Traffic flow with waypoint:
1. Source pod → ztunnel (outbound) → HBONE tunnel to waypoint
2. Waypoint applies L7 policy (AuthorizationPolicy, rate limits, retries)
3. Waypoint → ztunnel (internal) → HBONE tunnel to destination pod

### 7. NetworkPolicy Interaction

RHOAI's notebook controller creates restrictive NetworkPolicies that block HBONE on port 15008. This is the correct security posture — notebooks are intentionally locked down to the RHOAI gateway path (kube-auth-proxy in `redhat-ods-applications`).

For workloads that need cross-namespace mesh connectivity via HBONE, a NetworkPolicy allowing port 15008 ingress is required.

### 8. Dual Istio Control Planes

Two independent Istio instances coexist:

| Property | RHOAI Istio (`openshift-gateway`) | OSSM Ambient (`default`) |
|----------|----------------------------------|-------------------------|
| Namespace | `openshift-ingress` | `istio-system` |
| Version | v1.26.2 | v1.28.5 |
| Profile | (none — gateway only) | `ambient` |
| Owner | Ingress Operator (via GatewayClass) | Sail Operator (via ArgoCD) |
| Capabilities | Gateway API controller + OAuth | ztunnel + CNI + waypoint + gateway |
| CA | Default self-signed | **Custom CA chain** |

## Platform Prerequisites

### OVN-Kubernetes: `routingViaHost: true`

**Required.** Without this, kubelet health probes fail for all ambient-enrolled pods. Ambient mesh uses SNAT address `169.254.7.127` to exempt kubelet probes from ztunnel interception. OVN-Kubernetes must route through the host routing table for the return path to work.

### IstioCNI: `reconcileIptablesOnStartup: true`

**Recommended.** Eliminates race conditions where pods lose iptables interception rules during CNI restarts.

### Headed Services for KServe

KServe `rawDeploymentServiceConfig` must be `Headed`. Headless services bypass kube-proxy port mapping, breaking the service port (80) → container port (8080) translation that ztunnel relies on.

### App-Level TLS is Unnecessary

Applications serve **plain HTTP**. Ztunnel handles mTLS transparently. Removing app-level TLS eliminates certificate management complexity and double-encryption.

## Proving Encryption at Every Hop (Demo Verification)

### 1. Verify the Custom CA Cert Chain

```bash
# Show the cert chain the client sees through the mesh gateway
echo | openssl s_client -connect iris-onnx.apps.tallgeese.ultra.lab:443 \
  -showcerts 2>/dev/null | openssl x509 -noout -subject -issuer

# Expected:
#   subject=CN=mesh-gateway.apps.tallgeese.ultra.lab
#   issuer=O=tallgeese.ultra.lab, CN=Mesh Intermediate CA
```

### 2. Test Inference Through the Mesh Gateway

```bash
# Extract root CA for client verification
oc get secret mesh-root-ca-secret -n istio-system \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/root-ca.pem

# Inference with full cert verification
curl --cacert /tmp/root-ca.pem \
  https://iris-onnx.apps.tallgeese.ultra.lab/v2/models/iris-onnx/infer \
  -H "Content-Type: application/json" \
  -d '{"inputs":[{"name":"input","shape":[1,4],"datatype":"FP32","data":[5.1,3.5,1.4,0.2]}]}'
```

### 3. Prove mTLS via Ztunnel Access Logs

```bash
# Watch traffic flow with SPIFFE identities
oc logs -n ztunnel -l app=ztunnel --since=30s | grep "access"

# Look for:
#   src.identity="spiffe://cluster.local/ns/istio-system/sa/mesh-gateway-istio"
#   dst.identity="spiffe://cluster.local/ns/super-slim-demo/sa/default"
#   dst.hbone_addr=10.x.x.x:8080 (HBONE tunnel, not direct)
```

### 4. Packet Capture — Wire-Level Proof

```bash
NODE=$(oc get pod -n super-slim-demo -l app=isvc.iris-onnx-predictor \
  -o jsonpath='{.items[0].spec.nodeName}')
oc debug node/$NODE -- chroot /host \
  tcpdump -i any -c 20 port 15008 -w /tmp/mesh-traffic.pcap

# The capture shows TLS 1.3 handshakes on port 15008, not plaintext
```

### 5. Security Posture Summary

| Hop | Before Mesh | After Mesh | Proof |
|-----|------------|-----------|-------|
| Client → OCP Router | TLS 1.3 | TLS 1.3 (passthrough) | SNI routing, no termination |
| Router → Mesh Gateway | N/A | **Custom CA TLS** | `openssl s_client` shows cert chain |
| Gateway → Model Pod | **Plain HTTP** | **HBONE mTLS** | ztunnel logs show SPIFFE IDs |
| Pod → Pod (east-west) | **None** | **HBONE mTLS** | tcpdump shows TLS on port 15008 |
| PeerAuthentication | None | **STRICT** | Plain HTTP connections rejected |
| Gateway → Notebook | **Plain HTTP** | **mTLS (ztunnel)** | ztunnel intercepts in pod netns |
| Kubelet → Pod (probes) | Plain TCP | Plain TCP (exempt) | SNAT 169.254.7.127 bypasses ztunnel |

## What This Enables for Multi-Mesh

The custom CA + ambient mesh architecture positions us for multi-cluster federation:

1. **Shared root CA**: The `cacerts` secret uses a cert-manager-managed CA. Deploy the same root CA to each cluster — all workload SPIFFE certs chain to one trust anchor.
2. **Cross-cluster service discovery**: Istio's multi-cluster model uses east-west gateways to tunnel traffic between clusters. HBONE is designed for this.
3. **Unified trust domain**: Same trust domain (`cluster.local`) + same root CA = cross-cluster mTLS without per-cluster configuration.
4. **Zero-trust everywhere**: STRICT PeerAuthentication across all clusters ensures every hop is mutually authenticated regardless of network topology.
