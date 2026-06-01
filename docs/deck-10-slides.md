# Securing AI Workloads with OSSM v3 and RHOAI
## 10-Slide Deck

---

### Slide 1: Title

**Securing AI Workloads with OSSM v3 and RHOAI**

End-to-end mTLS, customer-managed certificates, and traffic policy for Red Hat OpenShift AI

---

### Slide 2: The Problem

**RHOAI 3.4 has no east-west security**

- Embedded Istio is gateway-only — no pod-to-pod encryption
- Even with `enable-auth: true`, only server-side TLS (kube-rbac-proxy) — no mutual auth
- No workload identity (SPIFFE) — pods can't prove who they are
- No east-west encryption between pods
- Cannot bring your own CA or federate across clusters

| | Auth Off | Auth On | Gap |
|---|---|---|---|
| Router → Pod | Plain HTTP ❌ | TLS (server only) ⚠️ | No mutual auth |
| Workload Identity | None ❌ | None ❌ | No SPIFFE |
| Pod → Pod | Unencrypted ❌ | Unencrypted ❌ | No east-west |

---

### Slide 3: What is a Service Mesh?

**Identity-based security that follows the workload**

- **Data plane**: Transparent proxies intercept all pod traffic (ztunnel in ambient mode — no sidecars)
- **Control plane**: istiod manages config, distributes certs, enforces policy
- **mTLS**: Every connection mutually authenticated — both sides prove identity
- **SPIFFE**: Workload identity standard — `spiffe://cluster.local/ns/demo/sa/default`
- **Zero-trust**: No implicit trust from network location — every hop verified

---

### Slide 4: The Solution — OSSM v3 Ambient Mesh

**Layer on top of RHOAI — zero application changes**

- **Ambient mode**: No sidecars — ztunnel DaemonSet handles L4 mTLS per node
- **Waypoint proxies**: Opt-in L7 policy (AuthZ, retries, rate limits)
- **Mesh gateway**: North-south entry point with custom CA cert
- **Coexists** with RHOAI's embedded Istio — dashboard and notebooks unaffected

*(Architecture diagram: Client → OCP Router → Mesh Gateway → mTLS → Model Pod)*

---

### Slide 5: Security at Every Layer

**In-Cluster** — ztunnel automatic L4 mTLS, HBONE tunnels, PeerAuthentication STRICT

**External Access** — Mesh gateway terminates TLS with custom CA cert, HBONE mTLS to backends

**Cross-Cluster** — Same root CA on multiple clusters = cross-cluster mTLS (next phase)

| Hop | Before | After |
|-----|--------|-------|
| Client → Gateway | TLS | Custom CA TLS |
| Gateway → Model Pod | Plain HTTP | HBONE mTLS |
| Pod → Pod | None | HBONE mTLS |

---

### Slide 6: Certificate Management

**One customer-controlled CA chain for everything**

```
Customer Root CA (cert-manager, 10yr)
     └─► Intermediate CA (5yr)
           ├─► Gateway TLS cert (90d, auto-renewed)
           └─► Istio cacerts → SPIFFE workload certs (24h, auto-rotated)
```

- Bring your own root CA — replace with corporate PKI
- cert-manager handles full lifecycle — zero manual rotation
- Same root CA across clusters = multi-cluster trust

---

### Slide 7: Traffic Management

**L4 automatic, L7 opt-in**

| Layer | Provided by | Capabilities |
|-------|------------|-------------|
| L4 (always on) | ztunnel | mTLS, connection load balancing, TCP metrics |
| L7 (opt-in) | waypoint proxy | AuthorizationPolicy, retries, timeouts, rate limits, request routing |

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

---

### Slide 8: Demo

1. Show RHOAI's gateway-only Istio (the gap)
2. Ambient mesh enrollment (namespace labels, ztunnel interception)
3. Custom CA chain (cert-manager → openssl verify)
4. Inference through mesh gateway (curl with `--cacert`)
5. mTLS proof (ztunnel SPIFFE identities in access logs)
6. AuthorizationPolicy (restrict model access, show 403)
7. Kiali topology view

---

### Slide 9: Benefits

| Benefit | How |
|---------|-----|
| Zero-trust security | STRICT mTLS — every hop mutually authenticated |
| No app changes | Ambient mode — transparent, no sidecars |
| Customer-controlled trust | Bring your own CA — all certs chain to your root |
| Compliance | Encryption in transit at every layer, auditable access logs |
| Multi-cluster ready | Shared root CA enables cross-cluster federation |
| Defense in depth | L7 AuthorizationPolicy restricts service-to-service access |
| Operational simplicity | cert-manager + Istio handle full cert lifecycle |

---

### Slide 10: What's Next

- **Multi-cluster federation** — shared root CA, cross-cluster service discovery, east-west gateways
- **Production hardening** — External Secrets for CA keys, NetworkPolicy + AuthorizationPolicy layering
- **Additional workloads** — model registry, pipelines, training jobs enrolled in mesh
