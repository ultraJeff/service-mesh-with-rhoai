# Securing AI Workloads with OSSM v3 and RHOAI
## 10-Slide Deck

---

### Slide 1: Title

**Securing AI Workloads with OSSM v3 and RHOAI**

End-to-end mTLS, customer-managed certificates, and traffic policy for Red Hat OpenShift AI

---

### Slide 2: RHOAI Already Uses Service Mesh

**RHOAI 3.4 uses Service Mesh 3 for Gateway API ingress**

- North-south traffic routing and OAuth authentication out of the box
- Transaction path: Route → Gateway → Envoy → kube-auth-proxy → HTTPRoute → backend
- For most deployments, this is sufficient

**For regulated environments, we extend it with ambient mesh:**

| Capability | RHOAI Alone | RHOAI + Mesh |
|---|---|---|
| Ingress TLS | Yes | Yes (custom CA) |
| Mutual authentication | No | **Yes (mTLS)** |
| Workload identity | No | **Yes (SPIFFE)** |
| East-west encryption | No | **Yes (ztunnel)** |
| Customer-managed CA | No | **Yes (cert-manager)** |
| L7 authorization policy | No | **Yes (waypoint)** |

---

### Slide 3: What is a Service Mesh?

**Identity-based security that follows the workload**

- **Data plane**: ztunnel (Rust, per-node) handles L4 mTLS transparently — no sidecars
- **Control plane**: istiod manages config via xDS, distributes SPIFFE certs
- **Waypoint proxies**: Envoy (opt-in, per-namespace) for L7 policy — AuthZ, retries, timeouts
- **SPIFFE**: Workload identity — `spiffe://cluster.local/ns/super-slim-demo/sa/default`
- **Zero-trust**: STRICT PeerAuthentication — every hop mutually authenticated

---

### Slide 4: The Solution — OSSM v3 Ambient Mesh

**Layer on top of RHOAI — zero application changes**

- Enrollment = two namespace labels
- Apps serve plain HTTP internally — ztunnel encrypts on the wire
- Coexists with RHOAI's embedded Istio — dashboard and notebooks unaffected
- Mesh gateway for north-south model traffic with custom CA cert

*(Architecture diagram: Client → OCP Router → Mesh Gateway → ztunnel mTLS → Model Pod)*

---

### Slide 5: Customer-Controlled Certificates

**One CA chain controls everything**

```
Customer Root CA (cert-manager, 10yr)  ← shared across clusters
     └─► Intermediate CA (5yr)          ← unique per cluster
           ├─► Gateway TLS cert (90d)   [cert-manager auto-renews]
           └─► Istio cacerts secret     [istiod signs SPIFFE certs, 24h auto-rotation]
```

- Bring your own root CA — swap with corporate PKI
- cert-manager handles lifecycle — zero manual rotation
- Optional: Zero Trust Workload Identity Manager (SPIRE) for centralized governance

---

### Slide 6: Security at Every Layer

**In-Cluster** — ztunnel automatic L4 mTLS, HBONE tunnels, STRICT PeerAuthentication

**External** — Mesh gateway terminates TLS with custom CA cert, HBONE mTLS to backends

**Authorization** — Waypoint proxy enforces L7 policy based on SPIFFE identity

| Hop | RHOAI Alone | RHOAI + Mesh |
|-----|-------------|-------------|
| Client → Gateway | TLS | Custom CA TLS |
| Gateway → Model | Depends on config | HBONE mTLS |
| Pod → Pod | Not encrypted | HBONE mTLS |
| Access control | Network-based | Identity-based (SPIFFE) |

---

### Slide 7: Traffic Management

**L4 automatic, L7 opt-in**

| Layer | Provided by | Capabilities |
|-------|------------|-------------|
| L4 (always on) | ztunnel | mTLS, connection load balancing, TCP metrics |
| L7 (opt-in) | waypoint proxy | AuthorizationPolicy, retries, timeouts, rate limits |

**Demo: retry policy**
- Without retries: 503 error reaches the client
- With retries: waypoint retries 3x on 5xx errors automatically
- Timeout: 10s delay cut to 5s — client gets fast failure, not infinite wait
- One VirtualService YAML — the app needs no retry logic

---

### Slide 8: Demo

*(Live demo via interactive console — http://localhost:3000)*

1. **Live inference** — run model, show mTLS proof with SPIFFE identities
2. **Why it matters** — RHOAI gateway baseline + what mesh adds
3. **How it works** — ztunnel, iptables interception, namespace labels
4. **Certificates** — CA chain, cacerts secret, SPIFFE lifecycle, live cert
5. **Zero trust** — with cert, without cert, bypass (all rejected)
6. **Authorization** — apply policy, gateway allowed, test-client blocked
7. **Traffic management** — retries, timeouts
8. **Multi-cluster** — shared root CA fingerprints, roadmap

---

### Slide 9: Benefits

| Benefit | How |
|---------|-----|
| Zero-trust security | STRICT mTLS — every hop mutually authenticated |
| No app changes | Ambient mode — transparent, no sidecars |
| Customer-controlled trust | Bring your own CA — all certs chain to your root |
| Compliance | Encryption in transit at every layer, auditable access logs |
| Traffic resilience | Retries, timeouts, circuit breaking via waypoint |
| Defense in depth | L7 AuthorizationPolicy restricts service-to-service access |
| Operational simplicity | cert-manager + Istio handle full cert lifecycle |
| Multi-cluster ready | Shared root CA — cross-cluster trust in OSSM 3.4 |

---

### Slide 10: What's Next

- **Ambient multi-cluster** — cross-cluster mTLS routing in OSSM 3.4 (Istio 1.29 Beta)
  - Trust infrastructure already in place (shared root CA)
  - Version upgrade, not a rebuild
- **BackendTLSPolicy** — OCP Gateway natively connects to mesh backends (OCP 4.22)
- **Production hardening** — External Secrets for CA keys, defense in depth with NetworkPolicy + AuthorizationPolicy
- **Additional workloads** — model registry, pipelines, training jobs enrolled in mesh
