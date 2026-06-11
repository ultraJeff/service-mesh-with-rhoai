# Demo Improvements Backlog

## Ready to implement

- **tcpdump proof button** — privileged pod with netshoot, nsenter into model pod's netns, capture port 8080 (readable) vs 15008 (encrypted). Requires granting/revoking privileged SCC. Could be a demo-console button with a warning.

- **Retries demo** — VirtualService retries didn't show up in waypoint Envoy config on Istio 1.28. Needs further debugging or may work on a newer OSSM version. HTTPRoute retries (GEP-1731) are in the Gateway API spec and implemented in Envoy Gateway v1.3+.

- **Multi-cluster traffic routing** — shared root CA is ready, service discovery works, but ztunnel data plane routing needs testing on clusters with L4 reachable E/W gateways (cloud LoadBalancers, not isolated VMs). May work on Istio 1.28 with proper infrastructure.

- **Separate gateway per LLM** — create a second `istio` GatewayClass Gateway with `allowedRoutes.namespaces.from: Selector` for namespace-level isolation. Different cert, different SPIFFE identity, different AuthorizationPolicy.

- **Native nftables mode** — test with `values.global.nativeNftables=true` to bypass iptables CLI and use kernel nftables directly. Available in Istio 1.28+.

- **ZTWIM/SPIRE integration** — deploy Zero Trust Workload Identity Manager and configure istiod to delegate cert signing to SPIRE. Would demonstrate hardware attestation and cross-cloud federation.

- **Kiali tracing integration** — deploy Tempo + OTel collector for distributed tracing in Kiali. Was set up on tallgeese but not on the new cluster.

## Needs research

- **VirtualService retries through ambient waypoint** — why didn't retries appear in the waypoint Envoy config? Is it a config attachment issue or an Istio 1.28 limitation?

- **BackendTLSPolicy on OCP** — GA in Gateway API v1 but CRD not present on OCP 4.20. When will it be available? Is it usable through OSSM's Istio even without native OCP support?

- **Authorino vs kube-rbac-proxy** — `enable-auth: true` uses kube-rbac-proxy for basic KServe. Authorino is the RHCL/MaaS path. Document the exact boundary between these two mechanisms.

- **eBPF-based traffic interception** — Istio supports eBPF as an alternative to iptables for traffic redirection. How does this change the security story? Does it affect the tcpdump/eBPF visibility answer?

- **PeerAuthentication port-level in ambient** — known bug (GitHub #53884) where port-level PERMISSIVE overrides may not work correctly in ambient mode. Test on current version.
