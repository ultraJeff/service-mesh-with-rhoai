# Demo Walkthrough

Run the console: `cd demo-console && npm install && node server.js` → http://localhost:3000

Make sure you're on the RHOAI context: `oc config use-context rhoai`

---

## Part 1: Let's Start with a Live Model (2 min)

**Open section 1 (it starts expanded).**

"Before we talk about architecture, let me show you something real. This is a live ML model running on RHOAI, served through an encrypted mesh."

1. Click **Show Pod Containers** — "The model pod has three containers: the model runtime, RHOAI's auth proxy, and the model weights. And transparently, ztunnel on the node handles mTLS for all traffic in and out."

2. Point at the **traffic path diagram** — "When I call this model, the request goes through the OCP Router as a passthrough, hits our mesh gateway which terminates TLS with our custom CA cert, then ztunnel creates an mTLS tunnel to the model pod. Let me show you."

3. Click **Run Inference** — "There's the prediction. And below it, the ztunnel access log shows both SPIFFE identities — the gateway authenticated itself, the model pod authenticated itself. Mutual TLS."

---

## Part 2: Why This Matters (2 min)

**Click section 2 to expand.**

"RHOAI already uses Service Mesh 3 for ingress — that's not new. Let me show you what it does."

1. Click **Show RHOAI Gateway Transaction Path** — walk through the 7-step flow. "This handles north-south routing and OAuth. For most deployments, it's enough."

2. Point at the **value table** — "For regulated environments that need mutual authentication, workload identity, and east-west encryption, we layer ambient mesh on top. Everything in the right column is what we add. Nothing in the left column changes."

*If someone asks about BackendTLSPolicy, open the deep-dive.*

---

## Part 3: How It Works (3 min)

**Click section 3.**

"Ambient mode. No sidecars. No app changes."

1. Click **Istio CRs** — "Two Istio instances coexist. RHOAI's handles the gateway. Ours handles encryption."

2. Click **ztunnel Pods** — "One ztunnel per node. It intercepts all traffic for enrolled pods."

3. Click **Show iptables Rules** — "This is how ztunnel intercepts — istio-cni injects iptables rules into each pod's network namespace. Everything gets redirected through ztunnel. The app has no idea."

4. Click **Show Namespace Labels** — "And all it took to enroll is two labels on the namespace. That's it."

*For technical audiences, open the deep-dives on ztunnel vs Envoy and sidecar vs ambient.*

---

## Part 4: Customer-Controlled Certificates (3 min)

**Click section 4.**

"All certificates chain to one root CA that you control."

1. Click **Show CA Chain Architecture** — walk down the chain. "Root CA is shared across clusters. Intermediate is unique per cluster. Gateway cert is what external clients see. And istiod uses the intermediate to sign SPIFFE workload certs every 24 hours, automatically."

2. Click **Show cacerts Secret** — "This is where you put your certs. One secret, four keys. Your PKI team provides the root and intermediate, you create the secret, Istio handles everything else."

3. Click **Verify Full Cert Chain** — "And here's proof it's all connected. Gateway cert signed by the intermediate, intermediate signed by the root."

4. Click **Show the Flow** — "Here's how a workload gets its identity. Nine steps, all automatic. The SPIFFE URI is the SAN field in the certificate. This is what AuthorizationPolicy matches on."

5. Click **Show Live Certificate** — "Here's the actual cert from the waypoint proxy. You can see the SPIFFE SAN, the validity window, and the signing CA."

*For ZTWIM/SPIRE questions, point at the callout box.*

---

## Part 5: Zero Trust — Prove It (2 min)

**Click section 5.**

"STRICT mTLS. Let me prove it works."

1. Click **Test via Gateway** — "Through the gateway with our CA cert — 200, works."

2. Click **Test Without CA Cert** — "Same URL, no CA cert — rejected. The client doesn't trust our CA."

3. Click **Try Direct Access** — "Bypass the gateway entirely, no SPIFFE identity — blocked. STRICT mTLS rejected the connection."

4. Click **Show Audit Trail** — "And every one of those connections — allowed and denied — is logged with the SPIFFE identity, timestamp, bytes transferred. This is your compliance audit trail, no agent needed."

*For PeerAuthentication questions, open the deep-dive.*

---

## Part 6: L7 Authorization (3 min)

**Click section 6.**

"Beyond encryption — who can call the model?"

1. Click **External → Iris** and **Test Client → Iris** — "Right now, both paths work. Anyone in the mesh can call the model."

2. Click **Apply AuthorizationPolicy** — "One YAML. We restrict the model to only accept traffic from the mesh gateway."

3. Click **What does this policy say?** — "Only these two SPIFFE identities are allowed. Everything else is denied."

4. Click **External → Iris** and **Test Client → Iris** again — "Gateway still works — 200. But the test client pod is blocked. It doesn't have an authorized identity."

5. Click **Remove Policy** — clean up.

*For waypoint flow questions, open the deep-dive. It explains the two-hop mTLS path and why mesh-waypoint needs to be in the allow list.*

---

## Part 7: Traffic Management (3 min)

**Click section 7.**

"The waypoint also handles traffic resilience."

1. Click **Call httpbin /status/503** — "httpbin returns a 503. Without retries, the client sees the error."

2. Click **Apply Retry Policy** then **What does this policy say?** — "Three retries on 5xx, 5 second timeout. One YAML."

3. Click **Call httpbin /delay/10** — "httpbin delays 10 seconds, but the policy times out at 5. The client gets a fast 504 instead of waiting forever. The app doesn't need retry logic — the mesh does it."

4. Click **Remove Policy** — clean up.

---

## Part 8: Multi-Cluster Trust (2 min)

**Click section 8.**

"Two clusters, one root CA."

1. Click **Compare Root CA Fingerprints** — "Same fingerprint on both clusters. Same trust anchor. Different intermediate CAs — each cluster signs its own workload certs."

2. Click **Compare Gateway Cert Chains** — "RHOAI cluster's gateway was signed by its intermediate. SNO cluster's was signed by its intermediate. Both chain to the same root."

3. Click **Show Multi-Cluster Status** — "Shared root CA is done. Cross-cluster traffic routing ships in the next OSSM release. The trust infrastructure is the hard part — that's already built. Cross-cluster mTLS is a version upgrade, not a rebuild."

4. Point at the **Kiali and OCP Console links** — "And you can see all of this in Kiali — the mesh topology, traffic flow, mTLS status."

---

## Closing

"We started with a live model and proved every hop is encrypted with mutual authentication. The certificates chain to a CA you control. The mesh enforces zero-trust access policy. And all of this coexists with RHOAI — no app changes, no sidecars, two namespace labels."
