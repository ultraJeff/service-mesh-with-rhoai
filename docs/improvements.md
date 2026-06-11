# Demo Improvements Backlog

## Ready to implement

- **tcpdump proof button** — privileged pod with netshoot, nsenter into model pod's netns, capture port 8080 (readable) vs 15008 (encrypted). Requires granting/revoking privileged SCC. Could be a demo-console button with a warning.

- **Retries demo** — VirtualService retries didn't show up in waypoint Envoy config on Istio 1.28. Needs further debugging or may work on a newer OSSM version. HTTPRoute retries (GEP-1731) are in the Gateway API spec and implemented in Envoy Gateway v1.3+.

- **Multi-cluster traffic routing** — shared root CA is ready, service discovery works, but ztunnel data plane routing needs testing on clusters with L4 reachable E/W gateways (cloud LoadBalancers, not isolated VMs). May work on Istio 1.28 with proper infrastructure.

- **Separate gateway per LLM** — create a second `istio` GatewayClass Gateway with `allowedRoutes.namespaces.from: Selector` for namespace-level isolation. Different cert, different SPIFFE identity, different AuthorizationPolicy.

- **Native nftables mode** — test with `values.global.nativeNftables=true` to bypass iptables CLI and use kernel nftables directly. Available in Istio 1.28+.

- **ZTWIM/SPIRE integration** — deploy Zero Trust Workload Identity Manager and configure istiod to delegate cert signing to SPIRE. Would demonstrate hardware attestation and cross-cloud federation.

- **Kiali tracing integration** — deploy Tempo + OTel collector for distributed tracing in Kiali. Was set up on tallgeese but not on the new cluster.

## Notes to incorporate into demo

- **NetworkPolicy is useless for ambient-enrolled workloads** — all mesh traffic arrives from ztunnel IPs. NetworkPolicy can't distinguish source workloads. AuthorizationPolicy replaces NetworkPolicy for access control in mesh namespaces. NetworkPolicy only remains relevant for non-mesh boundaries. All three selectors (podSelector, namespaceSelector, ipBlock) see ztunnel on the source side.

- **AuthorizationPolicy works because it reads identity from certs, not IPs** — ztunnel hides the real source IP but carries the real identity (SPIFFE SAN) inside the encrypted tunnel. AuthorizationPolicy reads the identity from the mTLS certificate, not from packet headers. That's why it works where NetworkPolicy fails.

- **HBONE is L7 for setup, L4 for data** — HTTP/2 CONNECT establishes the tunnel (L7 handshake with headers, destination address), then the connection degrades into a raw byte pipe (L4). No more HTTP semantics after the CONNECT completes. Similar to WebSocket upgrade. HTTP/2 chosen for multiplexing (multiple pods over one tunnel), metadata in the handshake, and built-in flow control.

- **Kafka and mesh don't conflict — they nest** — ztunnel is protocol-agnostic at L4. It sees opaque TCP bytes and wraps them in HBONE. Kafka's binary protocol (not HTTP) flows inside the tunnel unchanged. If Kafka also uses TLS, it's double encryption (Kafka TLS inside HBONE mTLS). Slight CPU overhead from double encrypt/decrypt, but modern AES-NI hardware makes this negligible. The HBONE tunnel is long-lived so handshake cost is amortized.

- **TCP is transport, not application** — TCP guarantees reliable ordered byte delivery. Application protocols (HTTP, Kafka binary, gRPC) give meaning to the bytes. ztunnel works at L4 (TCP) so it can tunnel ANY application protocol without understanding it. The waypoint works at L7 (HTTP) so it CAN'T do anything useful with non-HTTP protocols like Kafka — it just sees opaque bytes.

- **tcpdump proof procedure** — grant privileged SCC to SA, deploy netshoot pod with hostPID, nsenter into target pod's netns, capture port 8080 (readable plain HTTP) vs port 15008 (encrypted HBONE). Revoke SCC after. Validated on the cluster — works.

## Needs research

- **VirtualService retries through ambient waypoint** — why didn't retries appear in the waypoint Envoy config? Is it a config attachment issue or an Istio 1.28 limitation?

- **BackendTLSPolicy on OCP** — GA in Gateway API v1 but CRD not present on OCP 4.20. When will it be available? Is it usable through OSSM's Istio even without native OCP support?

- **Authorino vs kube-rbac-proxy** — `enable-auth: true` uses kube-rbac-proxy for basic KServe. Authorino is the RHCL/MaaS path. Document the exact boundary between these two mechanisms.

- **eBPF-based traffic interception** — Istio supports eBPF as an alternative to iptables for traffic redirection. How does this change the security story? Does it affect the tcpdump/eBPF visibility answer?

- **PeerAuthentication port-level in ambient** — known bug (GitHub #53884) where port-level PERMISSIVE overrides may not work correctly in ambient mode. Test on current version.
