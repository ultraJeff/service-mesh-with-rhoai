# Demo Console Claims Validation Report

Validated against Istio upstream docs (latest/1.30, covering 1.28 behavior), Red Hat OSSM 3.2/3.3 docs, Gateway API docs, and upstream project sources.

Date: 2026-06-03

---

## 1. Ambient Mesh Architecture (ztunnel, istio-cni, HBONE, pod startup flow)

**VERIFIED** -- with minor corrections

The demo console's 6-step pod startup flow is substantively accurate:

- **istio-cni detects the new pod**: Correct. The istio-cni node agent responds to CNI events (pod creation/deletion) and watches the Kubernetes API server for ambient label changes. It also installs a chained CNI plugin that notifies it when pods are created in ambient-enrolled namespaces. ([Istio docs: Ztunnel traffic redirection](https://istio.io/latest/docs/ambient/architecture/traffic-redirection/))

- **nsenter and iptables injection**: Partially accurate. The demo says istio-cni uses `nsenter` to enter the pod's network namespace and inject iptables rules. The actual Istio docs describe it more precisely: "istio-cni enters the pod's network namespace and establishes network redirection rules." The mechanism is correct in spirit (entering the pod's netns from outside), though the implementation may use `setns()` syscalls rather than literally shelling out to `nsenter`. The iptables rules (PREROUTING to 15006, OUTPUT to 15001, exempt 169.254.7.127) match the documented rules exactly.

- **ztunnel creates listeners inside the pod's netns**: The demo says "ztunnel starts handling traffic for this pod. It's already listening on ports 15006/15001." This is slightly simplified. Per the docs, once istio-cni establishes redirect rules, it informs ztunnel over a Unix domain socket, and ztunnel creates listening sockets inside the pod's network namespace (on ports 15008, 15006, 15001) using the provided network namespace file descriptor. The ztunnel process runs in the host namespace but creates sockets inside the pod's namespace using low-level Linux socket APIs.

- **HBONE on port 15008**: Correct. HBONE is HTTP/2 CONNECT over mTLS on port 15008. ([Istio docs: HBONE](https://istio.io/latest/docs/ambient/architecture/hbone/))

- **Ports 15006/15001/15008**: Correct. 15006 = inbound plaintext listener, 15001 = outbound listener, 15008 = HBONE mTLS endpoint. The demo also mentions 15053 for DNS proxy, which is correct.

**Correction needed**: The demo says "istio-cni watches the kubelet for pod events." More precisely, istio-cni installs a chained CNI plugin that is invoked by the container runtime, and also watches the Kubernetes API server for label changes. It does not watch the kubelet directly.

---

## 2. SPIFFE Certificate Lifecycle (9-step flow)

**VERIFIED** -- with nuances

The demo's 9-step flow (pod starts -> ztunnel requests -> istiod validates via TokenReview -> signs cert -> 24h rotation) is accurate:

- **TokenReview API**: Confirmed. Istiod uses the `KubeJWTAuthenticator` which calls the Kubernetes TokenReview API to validate the service account JWT token carried with the CSR. ([Source](https://oneuptime.com/blog/post/2026-02-24-how-to-understand-istio-certificate-provisioning-workflow/view))

- **SAN is the SPIFFE identity**: Confirmed. The SPIFFE URI (e.g., `spiffe://cluster.local/ns/super-slim-demo/sa/default`) is placed in the Subject Alternative Name (SAN) field of the X.509 certificate. Istio puts identity in the SAN, not the Subject. ([Istio docs: Security](https://istio.io/latest/docs/concepts/security/))

- **24h rotation**: Confirmed. Default workload certificate lifetime is 24 hours, and ztunnel handles rotation automatically. ([Istio docs: Ambient data plane](https://istio.io/latest/docs/ambient/architecture/data-plane/))

- **ztunnel requests certs for pod identities**: Correct. The CA enforcement ensures that ztunnel can only request identities for pods on its node. Requests for identities not running on the node are rejected.

- **Certificate delivery via SDS**: In sidecar mode, certs are delivered via Envoy SDS API. In ambient mode, ztunnel manages certificates directly (it is the proxy, not a sidecar agent). The demo's step 7 ("ztunnel holds the cert in memory -- app never sees it") is correct.

---

## 3. PeerAuthentication STRICT with Port-Level PERMISSIVE Exceptions

**NEEDS CORRECTION** -- port-level requires a selector, and there are known issues in ambient mode

The demo says: "we allow PERMISSIVE on port 8082 (Prometheus metrics) while keeping STRICT on port 8080 (model serving)."

- **Selector is required**: The Istio docs state that `portLevelMtls` "only apply when a workload selector is specified." A namespace-level PeerAuthentication cannot use port-level overrides. You need a workload-specific policy with a `selector` targeting the relevant pods.

- **Known issue in ambient mode**: GitHub issue [#53884](https://github.com/istio/istio/issues/53884) documents that port-level PERMISSIVE overrides may not work as expected in ambient mode. When switching to ambient, the PeerAuthentication is converted to an authorization policy by istiod, and port-level exceptions can result in traffic being "explicitly denied" by the converted policy.

**Recommendation**: The demo's talking point about per-port PERMISSIVE is conceptually correct for sidecar mode, but should note (a) it requires a workload selector, and (b) there are known issues with this in ambient mode. If you rely on this for Prometheus scraping, test it explicitly.

---

## 4. AuthorizationPolicy Targeting Waypoint

**VERIFIED**

The demo's AuthorizationPolicy uses `targetRefs` pointing to `Gateway/mesh-waypoint`, which is the correct approach for ambient mode:

```yaml
targetRefs:
  - kind: Gateway
    group: gateway.networking.k8s.io
    name: mesh-waypoint
```

Per the Istio docs: "For an authorization policy to be attached to a waypoint it must have a targetRef which refers to the waypoint, or a Service which uses that waypoint." ([Istio docs: L7 features](https://istio.io/latest/docs/ambient/usage/l7-features/))

- **Namespace-wide AuthorizationPolicy (no targetRefs)**: In ambient mode, an AuthorizationPolicy without targetRefs or selectors applies at the ztunnel level (L4 only). It does NOT apply to waypoints. L7 attributes in such a policy would cause it to fail safe as a DENY policy. This is correctly handled in the demo by explicitly targeting the waypoint.

- **Using `selector` instead of `targetRefs`**: The docs warn against this: "If you use the old-style selector field instead of targetRefs, the policy might not apply correctly to waypoint proxies."

---

## 5. VirtualService Timeouts Through Waypoints

**VERIFIED** -- with a caveat about alpha status

The demo applies a VirtualService with `timeout: 5s` and retries, expecting the waypoint proxy to enforce them. This is correct:

- VirtualService with ambient mode is considered **Alpha** per Istio docs: "Usage of VirtualService with the ambient data plane mode is considered Alpha."
- Timeouts and retries DO work through waypoint proxies. The waypoint is an Envoy proxy that processes VirtualService configuration pushed via xDS. ([Istio docs: L7 features](https://istio.io/latest/docs/ambient/usage/l7-features/))
- "Without a waypoint proxy in place, this VirtualService will have no effect."

**Recommendation**: The demo correctly requires a waypoint for this to work. Consider noting the Alpha status of VirtualService in ambient mode in the deep-dive, and mention that HTTPRoute with Gateway API is the long-term direction (this is already noted in the deep-dive).

---

## 6. BackendTLSPolicy

**NEEDS CORRECTION** -- BackendTLSPolicy has graduated to GA (v1), not v1alpha3; OCP 4.22 availability is unconfirmed

The demo states: "BackendTLSPolicy (Gateway API v1alpha3) -- Expected in OCP 4.22."

- **API version**: BackendTLSPolicy has **graduated to GA** (`gateway.networking.k8s.io/v1`). The `v1alpha3` version is officially deprecated and will be removed in a future release. ([Gateway API releases](https://github.com/kubernetes-sigs/gateway-api/releases))

- **OCP 4.22 availability**: There is no public documentation confirming BackendTLSPolicy support in OCP 4.22 specifically. As of December 2025, BackendTLSPolicy was not available in OpenShift's native Gateway API implementation. However, OSSM 3.3 (Istio 1.28) includes Gateway API v1.4 and BackendTLSPolicy v1 support -- so it may be available through the service mesh path rather than OCP's native ingress controller. ([OSSM 3.3 blog](https://www.redhat.com/en/blog/openshift-service-mesh-33-adds-post-quantum-cryptography))

- **The demo's YAML example** uses `v1alpha3` -- this should be updated to `v1`.

**Corrections needed**:
1. Change "Gateway API v1alpha3" to "Gateway API v1 (graduated from v1alpha3)"
2. Change "Expected in OCP 4.22" to something more hedged, e.g., "Available via OSSM 3.3 (Istio 1.28); native OCP ingress support TBD"
3. Update the example YAML `apiVersion` from `v1alpha3` to `v1`

---

## 7. OCP Routes and HBONE

**VERIFIED** -- accurate assessment based on architectural reasoning

The demo states: "OCP Routes are L7 (HAProxy) and break the HBONE/mTLS passthrough. Do not use Routes for east-west gateways."

- **Architectural correctness**: OCP Routes use HAProxy, which operates at L7. For passthrough Routes, HAProxy uses SNI to route but does not modify the TLS stream. For reencrypt/edge Routes, HAProxy terminates TLS.
- **HBONE requires L4 passthrough**: HBONE is an HTTP/2 CONNECT tunnel over mTLS on port 15008. East-west gateways need raw TCP/L4 connectivity. HAProxy passthrough routes could theoretically forward TLS on port 443, but east-west gateways typically need direct L4 exposure on port 15008, which HAProxy is not designed for.
- **Not explicitly documented**: There is no Istio or OSSM document that explicitly says "do not use OCP Routes for east-west gateways." However, the Istio multi-cluster docs specify that east-west gateways need LoadBalancer services (MetalLB or cloud LB) for direct L4 connectivity.

**Assessment**: The claim is architecturally sound and practically correct, even though there is no single document that states it verbatim.

---

## 8. enable-auth Annotation

**NEEDS CORRECTION** -- the demo conflates older behavior with current RHOAI 3.x

The demo states: `security.opendatahub.io/enable-auth: "true"` injects kube-rbac-proxy and creates a reencrypt Route.

- **In RHOAI 3.x**: The `security.opendatahub.io/enable-auth` annotation enables authentication via **Authorino** (Red Hat Connectivity Link), not kube-rbac-proxy. The annotation triggers Authorino-based authentication using Istio AuthorizationPolicies. ([RHOAI 3.4 docs](https://docs.redhat.com/en/documentation/red_hat_openshift_ai_self-managed/3.4/html/deploy_models_using_distributed_inference_with_llm-d/enabling-authentication-and-authorization-for-llm-inference-service_distributed-inference))

- **kube-rbac-proxy in RHOAI**: kube-rbac-proxy IS present in model serving pods (the demo's pod container listing confirms this), but the exact mechanism by which it gets injected and its relationship to the `enable-auth` annotation is internal to the odh-model-controller. The annotation's documented behavior has evolved across RHOAI versions.

- **Reencrypt Route**: In RHOAI 3.x with Gateway API, the routing uses HTTPRoutes through the RHOAI gateway, not traditional OpenShift reencrypt Routes. The demo's architecture report correctly shows this as a Gateway API flow.

**Recommendation**: The demo should clarify that in the current RHOAI 3.4 version:
- The `enable-auth` annotation enables Authorino-based authentication
- The `kube-rbac-proxy` container visible in the pod is injected by the model controller
- The routing path uses Gateway API (not traditional OCP Routes for model traffic)

---

## 9. Waypoint Proxy Visibility (HTTP Body)

**VERIFIED** -- with important nuance about app-level TLS

The demo correctly states:

- "The waypoint sees the full HTTP stream" -- **Correct** when traffic is plain HTTP (which it is in ambient mode, since ztunnel handles mTLS transparently). The waypoint receives decrypted traffic from ztunnel and can see HTTP headers AND body.

- "The body is in Envoy's memory as it proxies the request" -- **Correct**. Envoy processes the full HTTP stream.

- "App-level TLS (enable-auth) prevents the waypoint from reading the body" -- **Partially correct**. If the application itself initiates TLS (end-to-end, independent of Istio mTLS), the waypoint cannot decrypt it and treats it as an opaque TCP stream. However, `enable-auth` with Authorino does not necessarily mean full end-to-end app TLS that would prevent waypoint inspection -- it depends on the specific configuration.

- "The waypoint can still route and retry based on headers, but the body is encrypted" -- **Incorrect if app-level TLS is used**. If the app encrypts with its own TLS, the waypoint cannot see headers OR body. It would only see encrypted bytes. The waypoint could still extract SNI via TLS inspection, but no HTTP-layer features would work.

**Recommendation**: Clarify in Option 3 that if the app uses its own TLS, the waypoint cannot see headers either (not just body). The only thing visible would be SNI from the TLS handshake.

---

## 10. Network Namespace and ztunnel (Plain HTTP Segment)

**VERIFIED** -- accurate

The demo states: "ztunnel delivers traffic to the app via the local network namespace (like localhost). The plain HTTP segment is truly just intra-netns."

Per the Istio docs:
- "Traffic is HBONE encapsulated and encrypted in the network namespace of the source pod itself, and eventually decapsulated and decrypted in the network namespace of the destination pod." ([Istio docs: Ambient data plane](https://istio.io/latest/docs/ambient/architecture/data-plane/))
- Ztunnel creates listening sockets inside the pod's network namespace using the netns file descriptor. The process `setns()` into the pod's netns, binds listeners on `127.0.0.1:{15008,15006,15001}`, then returns to its own netns.
- "Data will now enter and leave the pod network namespace encrypted."

The demo's characterization of "like two processes on localhost" is a reasonable analogy. The plain HTTP only exists between ztunnel's in-pod listeners and the app process, within the same network namespace. It never crosses a network boundary unencrypted.

---

## 11. Sidecar and Ambient Coexistence

**VERIFIED** -- with significant caveats the demo should mention

The demo states: "Sidecar and ambient can coexist in the same mesh. Label each namespace for one mode only."

This is confirmed by Istio docs. However, there are important caveats not mentioned:

1. **Sidecar-to-waypoint interoperability is listed as an unsupported feature** in the "Sidecar or ambient?" docs page. Traffic from sidecars to ambient workloads will usually bypass waypoint proxies, meaning L7 policies may not be enforced. ([Istio docs: Sidecar or ambient?](https://istio.io/latest/docs/overview/dataplane-modes/))

2. **HBONE must be enabled for sidecar-to-ambient**: Sidecar proxies need `ISTIO_META_ENABLE_HBONE=true` in proxy metadata. This is the default with the ambient profile but may need explicit configuration otherwise. ([GitHub issue #57213](https://github.com/istio/istio/issues/57213))

3. **Never apply both modes to the same namespace/pod**: If both labels are present, sidecar takes precedence, but this is not a supported configuration.

**Recommendation**: Add a note about the waypoint bypass caveat for sidecar-to-ambient traffic, as this could surprise users during migration.

---

## 12. Multi-Cluster Ambient

**NEEDS CORRECTION** -- maturity status and feature flag details need updating

The demo states several things about multi-cluster:

- **"`AMBIENT_ENABLE_MULTI_NETWORK=true` creates the `istio-east-west` GatewayClass"**: **Partially correct**. `AMBIENT_ENABLE_MULTI_NETWORK` is a pilot (istiod) environment variable that enables multi-network support in ambient mode. The east-west gateway is created by deploying a Gateway CR with the `istio-east-west` GatewayClass. The flag enables the functionality; it does not directly create the GatewayClass. ([Istio blog: Ambient multicluster](https://istio.io/latest/blog/2025/ambient-multicluster/))

- **Istio 1.28 status**: In Istio 1.28, ambient multi-cluster was **Alpha** (with waypoint improvements for remote network routing). The demo says "Tech Preview in OSSM 3.3 (Istio 1.28)" which aligns with Alpha.

- **"Reaches Beta in Istio 1.29 / OSSM 3.4"**: **Correct**. Multi-network multicluster was promoted to Beta in Istio 1.29. ([Istio blog: Ambient multi-network beta](https://istio.io/latest/blog/2026/ambient-multinetwork-multicluster-beta/))

- **Nested HBONE**: Ambient multicluster uses nested HBONE connections (outer for east-west gateway, inner for end-to-end encryption), which is more efficient than sidecar-mode multi-cluster.

- **`AMBIENT_ENABLE_MULTI_NETWORK_WAYPOINT`**: In Istio 1.28, there is also a separate flag `AMBIENT_ENABLE_MULTI_NETWORK_WAYPOINT` for enabling waypoint routing to remote networks, which can be disabled if it causes issues.

**Corrections needed**: The demo's description is mostly accurate for the Istio 1.28/OSSM 3.3 timeframe. Ensure the status is clearly marked as "Alpha in 1.28, Beta in 1.29."

---

## 13. xDS Protocol for ztunnel

**VERIFIED** -- with important nuance

The demo states: "Both ztunnel and Envoy get config from istiod via xDS."

This is correct, but the details matter:

- **ztunnel uses xDS transport**: Confirmed. "The ztunnel proxy uses xDS APIs to communicate with the Istio control plane." ([Istio docs: Ambient control plane](https://istio.io/latest/docs/ambient/architecture/control-plane/))

- **Custom resource types**: ztunnel uses the xDS transport API but with **purpose-built, ambient-specific resource types** -- NOT the same Envoy resource types (Listener, Cluster, Route, Endpoint). Ztunnel supports two xDS resources: **Address** (representing workloads and services) and **Authorization** (L4 authorization rules). ([GitHub: istio/architecture/ambient/ztunnel.md](https://github.com/istio/istio/blob/master/architecture/ambient/ztunnel.md))

- **Why custom types**: The custom types are 10x more efficient than Envoy types in size, allocations, and CPU time. Ztunnel can encode Istio semantics (like mTLS configuration) in compact, Istio-specific fields rather than verbose Envoy configuration.

- **Same gRPC protocol**: The transport mechanism (gRPC streaming) is the same as Envoy's xDS, but the payload types are different.

The demo's statement about "workload discovery, L4 authorization rules, SPIFFE certs (via SDS)" is accurate. The demo correctly notes that Envoy gets "full L7 config" while ztunnel gets "only what it needs."

**No correction needed**, but for technical accuracy the demo could note that ztunnel uses custom xDS resource types rather than standard Envoy xDS types.

---

## 14. cert-manager and Istio cacerts

**VERIFIED** -- with one important detail about reload behavior

The demo's description of the `cacerts` secret format is correct:

- **Key names**: `ca-cert.pem`, `ca-key.pem`, `root-cert.pem`, `cert-chain.pem` -- confirmed by [Istio docs: Plug in CA Certificates](https://istio.io/latest/docs/tasks/security/cert-management/plugin-ca-cert/).

- **Secret name**: Must be `cacerts` in the `istio-system` namespace.

- **Mapping from cert-manager**: The demo's mapping (intermediate tls.crt -> ca-cert.pem, intermediate tls.key -> ca-key.pem, root tls.crt -> root-cert.pem, intermediate + root -> cert-chain.pem) is correct.

- **Reload behavior**: The demo says "Istio checks for this secret by name at startup." This is **partially correct**:
  - **Default**: istiod loads the CA from the `cacerts` secret **only at startup**. Updating the secret requires restarting istiod.
  - **With `AUTO_RELOAD_PLUGIN_CERTS=true`**: istiod watches the secret and dynamically reloads when it changes, with no restart needed. ([Tetrate blog: Automate Istio CA rotation](https://tetrate.io/blog/automate-istio-ca-rotation-in-production-at-scale))

**Recommendation**: If `AUTO_RELOAD_PLUGIN_CERTS=true` is set in your Istio CR, update the demo text to say "istiod watches this secret and reloads dynamically." If not, note that istiod restart is required after updating the secret.

---

## 15. ZTWIM (Zero Trust Workload Identity Manager)

**VERIFIED** -- the integration path described is accurate

The demo states: "SPIRE server -> istiod (as agent) -> SPIFFE certs."

- **ZTWIM is GA**: Red Hat's Zero Trust Workload Identity Manager is generally available on OpenShift. It is included with Red Hat Advanced Cluster Management, Red Hat Advanced Cluster Security, and Red Hat OpenShift Platform Plus. ([Red Hat blog: ZTWIM GA](https://www.redhat.com/en/blog/zero-trust-workload-identity-manager-generally-available-red-hat-openshift))

- **SPIRE server integration with istiod**: Confirmed. The integration involves configuring istiod with the SPIRE trust domain, setting `WORKLOAD_IDENTITY_SOCKET_FILE` to `spire-agent.sock`, and using a sidecar injector template named `spire` that mounts the SPIFFE UDS socket. ([Red Hat Developer: Sky computing with OSSM and SPIRE](https://developers.redhat.com/blog/2026/04/23/sky-computing-openshift-service-mesh-and-spire-foundations))

- **istiod "as agent"**: This is a simplification. More precisely, the workloads (sidecars/ztunnel) receive SPIFFE SVIDs from the SPIRE agent via the Workload API socket, and istiod is configured to use the SPIRE trust domain. The SPIRE agent runs as a DaemonSet, and the SPIRE server manages the trust hierarchy.

- **Hardware root of trust, cross-cloud federation**: Confirmed. ZTWIM supports node attestation plugins, OIDC federation, and SPIRE server-to-server federation for multi-cluster and multi-cloud scenarios.

- **Same SPIFFE format**: Correct. ZTWIM issues standard SPIFFE SVIDs, compatible with Istio's identity model.

**Minor clarification**: The demo says "istiod (as agent)" which is an oversimplification. In the SPIRE integration, istiod delegates identity issuance but the SPIRE agent (a separate DaemonSet) is the actual agent. istiod is configured to trust the SPIRE CA rather than its own built-in CA. The phrase "istiod as agent" could be misunderstood -- consider "istiod delegates to SPIRE" instead.

---

## Summary Table

| # | Topic | Verdict | Key Issue |
|---|-------|---------|-----------|
| 1 | Ambient mesh architecture | VERIFIED | Minor: istio-cni watches API server, not kubelet directly |
| 2 | SPIFFE certificate lifecycle | VERIFIED | Accurate on all points |
| 3 | PeerAuthentication port-level exceptions | NEEDS CORRECTION | Requires selector; known issues in ambient mode |
| 4 | AuthorizationPolicy targeting waypoint | VERIFIED | targetRefs approach is correct |
| 5 | VirtualService timeouts through waypoints | VERIFIED | Works; note Alpha status |
| 6 | BackendTLSPolicy | NEEDS CORRECTION | Now GA v1, not v1alpha3; OCP 4.22 unconfirmed |
| 7 | OCP Routes and HBONE | VERIFIED | Architecturally sound, not explicitly documented |
| 8 | enable-auth annotation | NEEDS CORRECTION | Uses Authorino in RHOAI 3.x, not just kube-rbac-proxy |
| 9 | Waypoint proxy visibility | VERIFIED | Clarify that app-TLS blocks headers too, not just body |
| 10 | Network namespace and ztunnel | VERIFIED | Accurate characterization |
| 11 | Sidecar and ambient coexistence | VERIFIED | Missing caveat: waypoint bypass for cross-mode traffic |
| 12 | Multi-cluster ambient | NEEDS CORRECTION | Alpha in 1.28, not just "Tech Preview"; flag details |
| 13 | xDS protocol for ztunnel | VERIFIED | Uses custom xDS types, not standard Envoy types |
| 14 | cert-manager and cacerts | VERIFIED | Note: reload requires AUTO_RELOAD_PLUGIN_CERTS=true |
| 15 | ZTWIM | VERIFIED | "istiod as agent" is a simplification |
