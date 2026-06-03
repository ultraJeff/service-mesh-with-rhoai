# Demo Script: OSSM v3 Ambient Mesh for RHOAI

This script mirrors the interactive demo console (`demo-console/`). Run the console locally with `cd demo-console && npm install && node server.js` and open `http://localhost:3000`.

## Pre-Demo

- Verify `oc config use-context rhoai` and both clusters are healthy
- Run the demo console and confirm sidebar shows green status
- Have root CA extracted: the console handles this automatically

## Part 1: Live Inference (2 min) — Hook

Show the pod containers (3/3: kserve, kube-rbac-proxy, modelcar), the traffic path diagram, then run inference. Auto-shows mTLS proof with SPIFFE identities.

**Key talking point:** "This is a live model on RHOAI. Watch the cert chain and the SPIFFE identities — every hop is mutually authenticated."

## Part 2: Why This Matters (2 min) — Context

Show the RHOAI gateway transaction path (the baseline). Then the value table: what mesh adds on top of RHOAI. Mention BackendTLSPolicy (OCP 4.22) if asked about the dual-gateway pattern.

**Key talking point:** "RHOAI already uses Service Mesh 3 for ingress. For regulated environments, we extend it with ambient mesh for mutual auth, workload identity, and east-west encryption."

## Part 3: How It Works (3 min) — Technical

Show Istio CRs (theirs vs ours), ztunnel pods, iptables rules, namespace labels. Deep-dive on ztunnel vs Envoy, xDS, HBONE if audience is technical.

**Key talking point:** "Two namespace labels. No sidecars, no app changes. ztunnel handles L4 mTLS on every node."

## Part 4: Certificates (3 min) — Trust

Show CA chain architecture, cacerts secret, cert chain verification, SPIFFE identity flow, live cert from waypoint. Mention ZTWIM if relevant.

**Key talking point:** "One root CA controls everything. cert-manager handles the lifecycle. In production, swap the root with your corporate PKI."

## Part 5: Zero Trust (2 min) — Proof

Three escalating tests: with CA cert (200), without CA cert (rejected), bypass gateway (rejected by STRICT mTLS). Deep-dive on PeerAuthentication if asked.

**Key talking point:** "STRICT mTLS — if you're not in the mesh, you can't reach the model."

## Part 6: Authorization (3 min) — Policy

Baseline (both paths work), apply AuthorizationPolicy, test again (gateway 200, test-client blocked). Show policy explainer. Deep-dive on waypoint two-hop flow.

**Key talking point:** "What if a compromised pod tries to call the model? The waypoint blocks it based on SPIFFE identity."

## Part 7: Traffic Management (3 min) — Resilience

Simulate 503 failure (client sees error), apply retry+timeout policy, test timeout (10s delay cut to 5s). Deep-dive on VirtualService vs HTTPRoute.

**Key talking point:** "The app doesn't need retry logic. One YAML and the mesh handles it."

## Part 8: Observability (2 min) — Visual

Generate traffic to both iris-onnx and httpbin, then show Kiali topology graph with traffic flow and error rates. Open OSSMConsole in OCP web console.

## Part 9: Multi-Cluster (2 min) — Forward-Looking

Compare root CA fingerprints (identical across clusters), compare gateway cert chains (different intermediates, same root). Show status: trust ready, cross-cluster routing in OSSM 3.4.

**Key talking point:** "Same root CA on both clusters. When ambient multi-cluster GAs, cross-cluster mTLS is a version upgrade, not a rebuild."
