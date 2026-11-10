# Deck Outline: Service Mesh for AI Workloads on OpenShift

## Slide 1: Title
**Securing AI Workloads with OSSM v3 and RHOAI**
End-to-end mTLS, customer-managed certificates, and traffic policy for Red Hat OpenShift AI

---

## Slide 2: The Problem
**RHOAI 3.4 has a TLS gap**

- RHOAI ships an embedded Istio — but it's gateway-only
- No pod-to-pod encryption, no mutual authentication
- Model inference traffic (vLLM, MLServer) is **plain HTTP** inside the cluster
- Notebooks are **plain HTTP** on the backend hop
- Cannot bring your own CA or federate across clusters

| Hop | Status |
|-----|--------|
| Client → Router | TLS ✅ |
| Router → Model Pod | **Plain HTTP** ❌ |
| Pod → Pod | **Unencrypted** ❌ |

*Speaker notes: The gateway handles north-south TLS but there's no east-west security. Any workload on the cluster can intercept model traffic.*

---

## Slide 3: Key Concepts — What is a Service Mesh?

- **Data plane**: Transparent proxies (ztunnel in ambient mode) intercept all pod traffic
- **Control plane**: istiod manages configuration, distributes certs, enforces policy
- **mTLS**: Every connection is mutually authenticated — both sides prove identity
- **SPIFFE**: Workload identity standard — `spiffe://cluster.local/ns/ossm-ai-models/sa/default`
- **Zero-trust**: No implicit trust based on network location — every hop is verified

*Speaker notes: Traditional network security (firewalls, network segmentation) doesn't work in Kubernetes — pods move, IPs change. The mesh provides identity-based security that follows the workload.*

---

## Slide 4: The Solution — OSSM v3 Ambient Mesh

**Layer OSSM v3 on top of RHOAI — no application changes**

- **Ambient mode**: No sidecars — ztunnel DaemonSet handles L4 mTLS per node
- **Waypoint proxies**: Optional L7 policy (AuthZ, retries, rate limits) per namespace
- **Mesh gateway**: North-south entry point for model traffic, replaces direct Routes
- **Coexists** with RHOAI's embedded Istio — no disruption to dashboard/notebooks

*Speaker notes: Ambient is the new deployment model in Istio. Instead of injecting a sidecar into every pod, ztunnel runs per-node and transparently intercepts traffic. Applications don't know the mesh exists.*

---

## Slide 5: Architecture Diagram

*(Use the diagram from architecture-report.md — the full north-south + east-west + control plane diagram)*

Key callouts:
- Client → OCP Router → Mesh Gateway → Model Pod (every hop encrypted)
- RHOAI Gateway retained for dashboard/notebook OAuth
- Custom CA chain controls all certificates

---

## Slide 6: Security — Communication at Every Layer

### In-Cluster (East-West)
- ztunnel provides **automatic L4 mTLS** for all pods in enrolled namespaces
- HBONE tunnels (HTTP/2 CONNECT over mTLS) on port 15008
- PeerAuthentication **STRICT** — plain HTTP rejected
- No application changes — apps serve plain HTTP, ztunnel encrypts

### External Access (North-South)
- Mesh gateway terminates TLS with **custom CA cert**
- Routes to backends via **HBONE mTLS**
- OCP passthrough Routes — client sees the custom CA cert chain
- RHOAI gateway still handles dashboard/notebook OAuth

### Cross-Cluster (Federation)
- Same root CA deployed to multiple clusters
- Workload SPIFFE certs are cross-trusted automatically
- East-west gateways tunnel traffic between clusters
- *(Demo on cloud clusters — next phase)*

---

## Slide 7: Certificate Management

**One CA chain controls everything**

```
  Customer Root CA (10yr, cert-manager)
       │
       ▼
  Intermediate CA (5yr)
       │
       ├──► Gateway TLS cert (90d, auto-renewed)
       │
       └──► Istio cacerts → SPIFFE workload certs (24h, auto-rotated)
```

- **cert-manager** manages the full chain — automatic renewal
- **Istio cacerts** secret bridges cert-manager to Istio's CA
- **SPIFFE SVIDs** issued to every workload — 24h TTL, auto-rotated
- **Bring your own CA**: Replace the self-signed root with your corporate PKI root
- **Multi-cluster**: Same root CA = cross-cluster trust, no per-cluster config

*Speaker notes: In production, the customer provides their root CA. cert-manager handles the intermediate CA and all leaf certs. Istio issues SPIFFE identity certs to workloads automatically — 24-hour TTL with zero-downtime rotation.*

---

## Slide 8: Traffic Management

**L4 automatic, L7 opt-in**

### L4 (ztunnel — always on)
- Automatic mTLS for all enrolled pods
- Connection-level load balancing
- TCP metrics and access logging

### L7 (waypoint proxy — per namespace)
- **AuthorizationPolicy**: Control which workloads can call which services
  - Example: Only mesh-gateway can call inference endpoints
- **Retries and timeouts**: Automatic retry on transient failures
- **Request routing**: Header-based routing, traffic splitting (canary)
- **Rate limiting**: Protect model endpoints from overload

```yaml
# Example: Only the mesh gateway can call the model
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
spec:
  targetRefs:
    - kind: Service
      name: iris-onnx-predictor
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/istio-system/sa/mesh-gateway-istio"
```

*Speaker notes: The waypoint proxy is an Envoy instance deployed per-namespace. It's only needed when you want L7 policies — ztunnel handles L4 encryption for free.*

---

## Slide 9: Observability

**Visibility into mesh traffic**

- **Kiali**: Service mesh topology, traffic flow, mTLS status
- **Distributed tracing**: Tempo + OpenTelemetry — trace requests across services
- **Metrics**: Prometheus integration — latency, error rates, throughput
- **ztunnel access logs**: SPIFFE identity on every connection — audit trail

*Speaker notes: Show Kiali graph with traffic flowing. Show the lock icons proving mTLS. Click into a connection to see the SPIFFE identities.*

---

## Slide 10: Benefits for Your Platforms

| Benefit | How |
|---------|-----|
| **Zero-trust security** | STRICT mTLS — every hop mutually authenticated |
| **No app changes** | Ambient mode — transparent encryption, no sidecars |
| **Customer-controlled trust** | Bring your own CA — all certs chain to your root |
| **Compliance** | Encryption in transit at every layer, auditable via access logs |
| **Multi-cluster ready** | Shared root CA enables cross-cluster federation |
| **Defense in depth** | L7 AuthorizationPolicy restricts service-to-service access |
| **Operational simplicity** | cert-manager auto-rotates all certs, Istio handles SPIFFE lifecycle |
| **Coexists with RHOAI** | No disruption — dashboard, notebooks, models all work |

---

## Slide 11: Demo

*(Live demo or recorded — follow demo-script.md)*

1. Show the problem (RHOAI gateway-only, plain HTTP)
2. Show ambient enrollment (namespace labels, ztunnel)
3. Custom CA chain (cert-manager, openssl verify)
4. Mesh gateway (inference with cert verification)
5. mTLS proof (ztunnel SPIFFE identities)
6. AuthorizationPolicy (restrict model access)
7. Kiali topology view

---

## Slide 12: What's Next

- **Multi-cluster federation** on cloud-hosted OpenShift clusters
  - Shared root CA across clusters
  - Cross-cluster service discovery
  - East-west gateways for inter-cluster mTLS
- **Production hardening**
  - External Secrets Operator for CA key material
  - NetworkPolicy + AuthorizationPolicy for defense in depth
  - Monitoring dashboards for mesh health
- **Additional RHOAI workloads**
  - Model registry, pipelines, training jobs enrolled in mesh

---

## Slide 13: Architecture Reference

*(Full architecture diagram — for reference during Q&A)*

---

## Appendix Slides

### A: Platform Prerequisites
- OVN-Kubernetes: `routingViaHost: true`
- IstioCNI: `reconcileIptablesOnStartup: true`
- KServe: `rawDeploymentServiceConfig: Headed`

### B: RHOAI Gateway Coexistence
- DSCI auto-creates GatewayConfig — cannot be suppressed
- Two Istio CRs coexist (openshift-gateway + default)
- RHOAI gateway handles OAuth for dashboard/notebooks
- Mesh gateway handles model inference traffic

### C: Ambient vs Sidecar Mode
| | Sidecar | Ambient |
|---|---|---|
| Proxy | Per-pod Envoy | Per-node ztunnel |
| Resource overhead | High (memory per pod) | Low (shared per node) |
| Pod modification | Yes (injection) | No |
| L7 policy | Always available | Opt-in (waypoint) |
| Restart required | Yes (for injection) | No |
