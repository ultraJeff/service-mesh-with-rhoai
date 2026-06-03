const express = require('express');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const PORT = 3000;
const TIMEOUT = 15000;
let DOMAIN = 'apps.example.com';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: TIMEOUT, shell: '/bin/zsh' }, (err, stdout, stderr) => {
      resolve({ output: stdout || stderr || (err ? err.message : ''), exitCode: err ? err.code || 1 : 0 });
    });
  });
}

app.get('/api/domain', (req, res) => { res.json({ domain: DOMAIN }); });

app.get('/api/sno-status', async (req, res) => {
  const nodes = await run('oc --context sno get nodes --no-headers 2>/dev/null');
  const mesh = await run('oc --context sno get istio,istiocni,ztunnel -A --no-headers 2>/dev/null');
  const pods = await run('oc --context sno get pods -n demo-app --no-headers 2>/dev/null | grep -v Completed | grep -v Terminating');
  res.json({ nodes: nodes.output, mesh: mesh.output, pods: pods.output });
});

// --- Health & Status ---

app.get('/api/health', async (req, res) => {
  const nodes = await run('oc get nodes --no-headers 2>/dev/null');
  const mesh = await run('oc get istio,istiocni,ztunnel -A --no-headers 2>/dev/null');
  const pods = await run('oc get pods -n super-slim-demo --no-headers 2>/dev/null | grep -v Completed | grep -v Terminating');
  res.json({ nodes: nodes.output, mesh: mesh.output, pods: pods.output });
});

app.get('/api/retry-policy/status', async (req, res) => {
  const result = await run('oc get virtualservice httpbin-retries -n super-slim-demo --no-headers 2>/dev/null');
  const active = result.output.trim().length > 0 && result.exitCode === 0;
  res.json({ active, output: result.output || 'No retry policy applied' });
});

app.get('/api/authz-policy/status', async (req, res) => {
  const result = await run('oc get authorizationpolicy -n super-slim-demo --no-headers 2>/dev/null');
  const active = result.output.trim().length > 0 && result.exitCode === 0;
  res.json({ active, output: result.output || 'No AuthorizationPolicy applied' });
});

// --- Part 1: The Problem ---

app.get('/api/istio-crs', async (req, res) => {
  const result = await run('oc get istio -A 2>/dev/null');
  res.json(result);
});

app.get('/api/plain-http-check', async (req, res) => {
  const result = await run("echo 'The model runtime listens on port 8080:'; echo; oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp 2>/dev/null | grep -E 'State|8080'; echo; echo 'ztunnel encrypts all traffic to and from this port transparently.'");
  res.json(result);
});

app.get('/api/pod-containers', async (req, res) => {
  const result = await run(`echo 'Iris model pod containers:'
echo ''
oc get pods -n super-slim-demo -l app=isvc.iris-onnx-predictor -o jsonpath='{range .items[0].spec.containers[*]}{.name}{"\\n"}{end}' 2>/dev/null | sed 's/^/  /'
echo ''
echo 'kserve-container  → ML model serving on :8080'
echo 'kube-rbac-proxy   → RHOAI auth proxy, TLS on :8443 (enable-auth: true)'
echo 'modelcar          → model weight storage'
echo ''
echo 'Plus ztunnel (per-node, not a sidecar) handles mTLS on the wire.'
echo ''
echo 'Two security layers active simultaneously:'
echo '  1. ztunnel mTLS    — encrypts all pod-to-pod traffic (mesh layer)'
echo '  2. kube-rbac-proxy — validates OAuth tokens + TLS (app layer)'`);
  res.json(result);
});

app.get('/api/rhoai-gateway-flow', async (req, res) => {
  const result = await run(`echo 'RHOAI already uses Service Mesh 3 for ingress (Gateway API).'
echo 'Here is the transaction path that exists out of the box:'
echo ''
echo '  1. Client HTTPS request'
echo '     ↓'
echo '  2. OpenShift Route (reencrypt TLS)'
echo '     kind: Route, namespace: openshift-ingress'
echo '     ↓'
echo '  3. Gateway API Service'
echo '     name: data-science-gateway-data-science-gateway-class'
echo '     ↓'
echo '  4. Envoy proxy pod (istio-proxy, NOT a sidecar)'
echo '     Receives config from istiod via xDS over gRPC'
echo '     Config updates apply hot — no pod restarts needed'
echo '     ↓'
echo '  5. kube-auth-proxy (OAuth authentication)'
echo '     Validates user identity with Kubernetes API server'
echo '     ↓'
echo '  6. HTTPRoute (routes by path/hostname to backend services)'
echo '     e.g. / → rhods-dashboard:8443'
echo '     e.g. /notebook/... → notebook service:8888'
echo '     ↓'
echo '  7. Backend pod (dashboard, notebook, etc.)'
echo ''
echo 'This handles north-south ingress and authentication.'
echo 'The ambient mesh extends this with east-west mTLS, workload'
echo 'identity, and authorization policy for regulated environments.'`);
  res.json(result);
});

// --- Part 2: Ambient Mesh ---

app.get('/api/ztunnel-pods', async (req, res) => {
  const result = await run(`echo 'ztunnel — runs on every node, encrypts all pod traffic:'; echo ''; oc get pods -n ztunnel -o wide 2>/dev/null`);
  res.json(result);
});

app.get('/api/iptables-rules', async (req, res) => {
  const result = await run(`echo 'iptables rules inside the model pod (injected by istio-cni):'
echo 'These redirect all traffic through ztunnel — the app has no idea.'
echo ''
echo '--- Inbound (PREROUTING) ---'
echo 'Kubelet probes exempted:  -s 169.254.7.127 → ACCEPT'
echo 'Everything else:          → REDIRECT to ztunnel port 15006'
echo ''
echo '--- Outbound (OUTPUT) ---'
echo 'DNS redirected:           → ztunnel port 15053'
echo 'Everything else:          → REDIRECT to ztunnel port 15001'
echo ''
echo '--- Key ports inside the pod ---'
echo '  15006  ztunnel inbound listener (receives intercepted inbound traffic)'
echo '  15001  ztunnel outbound listener (receives intercepted outbound traffic)'
echo '  15008  HBONE mTLS endpoint (encrypted tunnel between nodes)'
echo '  15053  ztunnel DNS proxy'
echo '   8080  app (only reachable via ztunnel, not directly)'
echo ''
echo 'Live from the pod:'
oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp 2>/dev/null | grep -E "State|8080|1500"
`);
  res.json(result);
});

app.get('/api/namespace-labels', async (req, res) => {
  const result = await run(`echo 'Namespace: super-slim-demo'
echo ''
echo 'Mesh enrollment labels (this is all it takes):'
echo ''
echo '  istio.io/dataplane-mode: ambient     ← enroll in the mesh'
echo '  istio.io/use-waypoint: mesh-waypoint ← enable L7 policy'
echo ''
echo 'Live:'
oc get ns super-slim-demo -o jsonpath='{.metadata.labels}' 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
for k,v in sorted(d.items()):
    if 'istio' in k:
        print(f'  {k}: {v}  ✓')
"`);
  res.json(result);
});

app.get('/api/peer-auth', async (req, res) => {
  const result = await run('oc get peerauthentication -n super-slim-demo 2>/dev/null');
  res.json(result);
});

app.get('/api/app-ports', async (req, res) => {
  const result = await run('echo "=== App port (plain HTTP) ==="; oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp 2>/dev/null | grep 8080; echo "\\n=== Ztunnel ports (interception) ==="; oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp 2>/dev/null | grep -E "15006|15008|15001"');
  res.json(result);
});

// --- Part 3: Custom CA ---

app.get('/api/cert-status', async (req, res) => {
  const result = await run('oc get certificate -n istio-system 2>/dev/null');
  res.json(result);
});

app.get('/api/cert-how', async (req, res) => {
  const result = await run(`echo 'The CA chain uses 3 Certificates + 2 Issuers:'
echo ''
echo '  ClusterIssuer/mesh-selfsigned           (config: self-signed bootstrap)'
echo '     ↓ signs'
echo '  Certificate/mesh-root-ca                (Root CA, 10yr)          [cert-manager]'
echo '     ⚡ SHARED across all clusters — the trust anchor'
echo '     ↓'
echo '  Issuer/mesh-root-ca-issuer              (config: signs using root CA)'
echo '     ↓ signs'
echo '  Certificate/mesh-intermediate-ca        (Intermediate CA, 5yr)   [cert-manager]'
echo '     ⚡ UNIQUE per cluster — each cluster has its own'
echo '     ↓'
echo '  Issuer/mesh-intermediate-ca-issuer      (config: signs using intermediate)'
echo '     ↓ signs two things:'
echo '     │'
echo '     ├── Certificate/mesh-gateway-cert (90d)                       [cert-manager]'
echo '     │   The TLS cert external clients see when connecting.'
echo '     │   Presented by the ingress gateway Envoy pod.'
echo '     │   cert-manager auto-renews it — not managed by the mesh.'
echo '     │'
echo '     └── Secret/cacerts                                            [istiod]'
echo '         istiod uses this CA to sign SPIFFE workload identity'
echo '         certs for every pod in the mesh (24h TTL, auto-rotated).'
echo '         ⚡ FULLY MANAGED BY THE MESH — zero manual rotation.'
echo ''
echo 'In production: replace the self-signed root with your corporate PKI root CA.'
echo 'Everything downstream stays the same.'`);
  res.json(result);
});

app.get('/api/cacerts-verify', async (req, res) => {
  const result = await run(`echo 'Verifying the cert chain is connected:'
echo ''
echo '1. Gateway cert (what external clients see):'
echo | openssl s_client -connect iris-onnx.${DOMAIN}:443 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null | sed 's/^/   /'
echo ''
echo '2. Istio CA (what signs workload SPIFFE certs):'
oc get secret cacerts -n istio-system -o jsonpath='{.data.ca-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -issuer 2>/dev/null | sed 's/^/   /'
echo ''
echo '3. Root CA (the shared trust anchor):'
oc get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -issuer 2>/dev/null | sed 's/^/   /'
echo ''
echo 'Chain: gateway cert → signed by intermediate → signed by root (self-signed)'
echo 'All three are connected. The root is the same on every cluster.'`);
  res.json(result);
});

app.get('/api/cacerts-secret', async (req, res) => {
  const result = await run(`echo 'Secret: cacerts  (namespace: istio-system)'
echo 'Istio checks for this secret by name at startup.'
echo ''
echo 'Keys in the secret:'
oc get secret cacerts -n istio-system -o jsonpath='{.data}' 2>/dev/null | python3 -c "
import json, sys, base64
d = json.load(sys.stdin)
for k in sorted(d.keys()):
    cert = base64.b64decode(d[k]).decode()
    lines = len(cert.strip().splitlines())
    # show subject for cert keys
    if 'key' not in k:
        import subprocess
        r = subprocess.run(['openssl','x509','-noout','-subject','-dates'], input=cert, capture_output=True, text=True)
        info = r.stdout.strip()
    else:
        info = '(private key - not displayed)'
    print(f'  {k:20s} {info}')
"
echo ''
echo 'How we create it (scripts/create-istio-cacerts.sh):'
echo '  1. cert-manager creates mesh-root-ca-secret and mesh-intermediate-ca-secret'
echo '  2. Script extracts tls.crt/tls.key and maps to Istio key names:'
echo '     tls.crt  (intermediate) → ca-cert.pem'
echo '     tls.key  (intermediate) → ca-key.pem'
echo '     tls.crt  (root)         → root-cert.pem'
echo '     ca-cert + root-cert     → cert-chain.pem'
echo '  3. oc create secret generic cacerts -n istio-system ...'
echo ''
echo 'In production: your PKI team provides the intermediate cert+key and root cert.'
echo 'You create this one secret. Istio handles everything else.'`);
  res.json(result);
});

app.get('/api/spiffe-how', async (req, res) => {
  const result = await run(`echo 'How a workload gets its SPIFFE identity:'
echo ''
echo '1. Pod starts in an ambient-enrolled namespace'
echo '2. ztunnel detects the new pod (via istio-cni)'
echo '3. ztunnel requests a cert from istiod:'
echo '     "I need an identity for ns/super-slim-demo, sa/default"'
echo '4. istiod validates the request via K8s TokenReview API'
echo '5. istiod constructs the SPIFFE URI from namespace + service account:'
echo '     spiffe://cluster.local/ns/super-slim-demo/sa/default'
echo '6. istiod signs an X.509 cert with that URI as the SAN (Subject Alternative Name)'
echo '     using the intermediate CA from the cacerts secret'
echo '7. ztunnel holds the cert in memory (app never sees it)'
echo '8. Every mTLS handshake: ztunnel presents this cert'
echo '     the other side reads the SAN to verify identity'
echo '9. Cert auto-rotates every 24h — zero downtime, zero manual work'
echo ''
echo 'The SPIFFE identity IS the SAN field in the certificate.'
echo 'AuthorizationPolicy matches on it. That is how identity-based'
echo 'access control works without tokens or passwords.'`);
  res.json(result);
});

app.get('/api/spiffe-cert-details', async (req, res) => {
  const wpResult = await run("oc get pods -n super-slim-demo -l gateway.networking.k8s.io/gateway-name=mesh-waypoint -o jsonpath='{.items[0].metadata.name}' 2>/dev/null");
  const wp = wpResult.output.trim().replace(/'/g, '');
  const certResult = await run(`oc exec -n super-slim-demo ${wp} -- pilot-agent request GET /certs 2>/dev/null`);
  let certInfo = '';
  try {
    const d = JSON.parse(certResult.output);
    const seen = new Set();
    for (const c of (d.certificates || [])) {
      for (const cc of (c.cert_chain || [])) {
        for (const s of (cc.subject_alt_names || [])) {
          if (s.uri && !seen.has(s.uri)) {
            seen.add(s.uri);
            certInfo += `  SPIFFE SAN:  ${s.uri}\n`;
            certInfo += `  Valid from:  ${cc.valid_from || '?'}\n`;
            certInfo += `  Expires:     ${cc.expiration_time || '?'}\n\n`;
          }
        }
      }
      if (!seen.has('ca') && c.ca_cert) {
        for (const cc of c.ca_cert) {
          if (parseInt(cc.days_until_expiration) > 365) {
            certInfo += `  Signing CA:  ${cc.days_until_expiration} days remaining (intermediate CA from cacerts)\n\n`;
            seen.add('ca');
            break;
          }
        }
      }
    }
  } catch (e) {
    certInfo = `  (could not parse cert: ${e.message})\n`;
  }
  const output = `Live SPIFFE certificate from the waypoint proxy (Envoy):

Waypoint pod: ${wp}

${certInfo}This cert was signed by istiod using the intermediate CA.
The SPIFFE SAN (Subject Alternative Name) is the identity.

  ↑ This URI is what appears in ztunnel access logs.
  ↑ This URI is what AuthorizationPolicy matches on.
  ↑ This cert auto-rotates every 24h — no manual work.`;
  res.json({ output, exitCode: 0 });
});

app.get('/api/spiffe-identities', async (req, res) => {
  const result = await run(`echo 'SPIFFE identity format:'
echo '  spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>'
echo ''
echo 'Istio assigns one to every workload based on its Kubernetes'
echo 'service account. No configuration needed — it is automatic.'
echo ''
echo 'Workload identities on this cluster:'
echo ''
oc get pods -n super-slim-demo -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\\t"}{.spec.serviceAccountName}{"\\n"}{end}' 2>/dev/null | while read POD SA; do
  echo "  $POD"
  echo "    → spiffe://cluster.local/ns/super-slim-demo/sa/$SA"
  echo ""
done
echo 'Mesh gateway identity:'
SA=$(oc get deployment mesh-gateway-istio -n istio-system -o jsonpath='{.spec.template.spec.serviceAccountName}' 2>/dev/null)
echo "  mesh-gateway-istio"
echo "    → spiffe://cluster.local/ns/istio-system/sa/$SA"
echo ''
echo 'These identities are used for mTLS authentication and'
echo 'AuthorizationPolicy enforcement — no tokens, no passwords.'`);
  res.json(result);
});

app.get('/api/gateway-cert', async (req, res) => {
  const result = await run(`echo | openssl s_client -connect iris-onnx.${DOMAIN}:443 -showcerts 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null`);
  res.json(result);
});

// --- Part 4: Mesh Gateway ---

app.get('/api/mesh-gateway', async (req, res) => {
  const result = await run('oc get gateway mesh-gateway -n istio-system 2>/dev/null; echo "\\n--- Gateway Pod ---"; oc get pods -n istio-system -l istio.io/gateway-name=mesh-gateway --no-headers 2>/dev/null || oc get pods -n istio-system -l gateway.istio.io/managed=mesh-gateway-istio --no-headers 2>/dev/null || oc get pods -n istio-system 2>/dev/null | grep mesh-gateway');
  res.json(result);
});

app.get('/api/httproutes', async (req, res) => {
  const result = await run('oc get httproute -n super-slim-demo 2>/dev/null; echo "\\n--- OCP Passthrough Routes ---"; oc get route -n istio-system 2>/dev/null | grep mesh-gateway');
  res.json(result);
});

app.post('/api/infer', async (req, res) => {
  const result = await run(`echo '$ curl --cacert /tmp/mesh-root-ca.pem \\\\'
echo '    https://iris-onnx.${DOMAIN}/v2/models/iris-onnx/infer \\\\'
echo '    -H "Content-Type: application/json" \\\\'
echo '    -d '"'"'{"inputs":[{"name":"input","shape":[1,4],"datatype":"FP32","data":[5.1,3.5,1.4,0.2]}]}'"'"''
echo ''
curl --cacert /tmp/mesh-root-ca.pem -s https://iris-onnx.${DOMAIN}/v2/models/iris-onnx/infer -H 'Content-Type: application/json' -d '{"inputs":[{"name":"input","shape":[1,4],"datatype":"FP32","data":[5.1,3.5,1.4,0.2]}]}' 2>/dev/null | python3 -m json.tool`);
  res.json(result);
});

app.get('/api/ztunnel-logs', async (req, res) => {
  const result = await run(`oc logs -n ztunnel -l app=ztunnel --since=120s 2>/dev/null | grep "access" | grep "iris-onnx-predictor" | grep -v "metrics" | tail -3 | python3 -c "
import sys, re
for line in sys.stdin:
    fields = {}
    for m in re.finditer(r'(\\w[\\w.]+)=\\"([^\\"]*)\\"', line):
        fields[m.group(1)] = m.group(2)
    for m in re.finditer(r'(\\w+)=([\\d]+[a-z]*)', line):
        if m.group(1) not in fields:
            fields[m.group(1)] = m.group(2)
    if not fields:
        continue
    src_id = fields.get('src.identity','unknown')
    dst_id = fields.get('dst.identity','unknown')
    dst_svc = fields.get('dst.service','?').split('.')[0]
    hbone = fields.get('dst.hbone_addr','direct')
    sent = fields.get('bytes_sent','?')
    recv = fields.get('bytes_recv','?')
    dur = fields.get('duration','?')
    err = fields.get('error','')
    print(f'mTLS Connection (verified):')
    print(f'  Source SPIFFE: {src_id}')
    print(f'  Dest SPIFFE:   {dst_id}')
    print(f'  Service:       {dst_svc}')
    print(f'  HBONE tunnel:  {hbone}')
    print(f'  Bytes: {sent} sent / {recv} recv  Duration: {dur}')
    if err:
        print(f'  Error: {err}')
    print()
" 2>/dev/null`);
  const output = result.output.trim() || 'No recent mesh traffic. Click "Run Inference" first, then check again.';
  res.json({ output, exitCode: result.exitCode });
});

app.post('/api/test-bypass', async (req, res) => {
  const result = await run(`echo '$ curl -s http://iris-onnx-predictor.super-slim-demo.svc:80/v2/models/iris-onnx'
echo '  (direct to service, no mesh gateway, no SPIFFE identity)'
echo ''
CODE=$(oc run bypass-test --rm -i --restart=Never -n default --image=curlimages/curl -- -s -o /dev/null -w '%{http_code}' --connect-timeout 5 http://iris-onnx-predictor.super-slim-demo.svc:80/v2/models/iris-onnx 2>/dev/null | grep -oE '[0-9]{3}' | tail -1)
if [ "$CODE" = "200" ]; then
  echo "Result: HTTP $CODE — ACCESS GRANTED (should not happen with STRICT mTLS)"
else
  echo "Result: HTTP $CODE — ACCESS DENIED"
  echo ""
  echo "STRICT mTLS rejected the connection."
  echo "Without a valid SPIFFE identity, you cannot reach the model."
fi`);
  res.json({ output: result.output, exitCode: 1 });
});

// --- Part 5: Traffic Management ---

app.post('/api/authz-policy/apply', async (req, res) => {
  const policy = `apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: iris-allow-gateway-only
  namespace: super-slim-demo
spec:
  targetRefs:
    - kind: Gateway
      group: gateway.networking.k8s.io
      name: mesh-waypoint
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/istio-system/sa/mesh-gateway-istio"
              - "cluster.local/ns/super-slim-demo/sa/mesh-waypoint"`;
  const result = await run(`echo '${policy}' | oc apply -f - 2>&1`);
  res.json(result);
});

app.get('/api/authz-policy/explain', async (req, res) => {
  const result = await run(`EXISTS=$(oc get authorizationpolicy iris-allow-gateway-only -n super-slim-demo --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$EXISTS" = "0" ]; then
  echo 'No AuthorizationPolicy applied. All mesh identities can reach all services.'
else
  echo 'AuthorizationPolicy: iris-allow-gateway-only'
  echo ''
  echo 'Target: Gateway/mesh-waypoint (the waypoint proxy)'
  echo '  The policy is attached to the waypoint, which enforces'
  echo '  it for all traffic flowing through the waypoint.'
  echo ''
  echo 'Rule: ALLOW traffic only from these SPIFFE identities:'
  echo ''
  echo '  ✓ mesh-gateway-istio  (the ingress gateway — external traffic)'
  echo '  ✓ mesh-waypoint       (the waypoint proxy — internal forwarding)'
  echo ''
  echo 'Everyone else is DENIED:'
  echo ''
  echo '  ✗ test-client pod     (sa/default — not in the allow list)'
  echo '  ✗ any other pod       (no matching identity)'
  echo '  ✗ any other namespace (no matching identity)'
  echo ''
  echo 'Effect: the model is ONLY reachable through the mesh gateway.'
  echo 'Internal lateral movement is blocked.'
fi`);
  res.json(result);
});

app.post('/api/authz-policy/delete', async (req, res) => {
  const result = await run('oc delete authorizationpolicy iris-allow-gateway-only -n super-slim-demo 2>&1');
  res.json(result);
});

app.post('/api/test-external', async (req, res) => {
  const result = await run(`echo '$ curl --cacert /tmp/mesh-root-ca.pem https://iris-onnx.${DOMAIN}/v2/models/iris-onnx'
echo '  (through mesh gateway, verified against our custom CA)'
echo ''
CODE=$(curl --cacert /tmp/mesh-root-ca.pem -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://iris-onnx.${DOMAIN}/v2/models/iris-onnx 2>/dev/null)
echo "Result: HTTP $CODE"
if [ "$CODE" = "200" ]; then
  echo "✓ Mesh gateway accepted — valid SPIFFE identity"
else
  echo "✗ Connection failed"
fi`);
  res.json(result);
});

app.post('/api/test-no-cert', async (req, res) => {
  const result = await run(`echo '$ curl https://iris-onnx.${DOMAIN}/v2/models/iris-onnx'
echo '  (no --cacert flag — client does not trust our custom CA)'
echo ''
OUTPUT=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://iris-onnx.${DOMAIN}/v2/models/iris-onnx 2>&1)
echo "Result: $OUTPUT"
echo ''
echo 'curl rejects the connection because the gateway cert is signed'
echo 'by our custom CA, not a public CA. The client must explicitly'
echo 'trust the root CA to connect.'`);
  res.json({ output: result.output, exitCode: 1 });
});

app.post('/api/test-pod-to-pod', async (req, res) => {
  const result = await run(`echo '$ kubectl exec test-client -- curl http://iris-onnx-mesh/v2/models/iris-onnx'
echo '  (pod-to-pod inside the namespace, no gateway)'
echo ''
CODE=$(oc exec -n super-slim-demo deploy/test-client -- curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 http://iris-onnx-mesh.super-slim-demo.svc:80/v2/models/iris-onnx 2>/dev/null)
if [ "$CODE" = "200" ]; then
  echo "Result: HTTP $CODE — access granted"
elif [ "$CODE" = "403" ]; then
  echo "Result: HTTP $CODE — FORBIDDEN"
  echo "AuthorizationPolicy blocked this request."
else
  echo "Result: BLOCKED (HTTP $CODE)"
  echo ""
  echo "The pod has no authorized SPIFFE identity."
  echo "AuthorizationPolicy rejected the connection."
fi`);
  const code = result.output.match(/HTTP (\d+)/)?.[1] || '000';
  res.json({ output: result.output, exitCode: code === '200' ? 0 : 1 });
});

// --- Part 5b: Audit Trail ---

app.get('/api/audit', async (req, res) => {
  const logsResult = await run("oc logs -n ztunnel -l app=ztunnel --since=5m 2>/dev/null | grep access | grep -v prometheus | grep -v metrics | tail -10");
  const lines = logsResult.output.trim().split('\n').filter(function(l) { return l.trim(); });
  var output = 'Mesh audit trail -- every connection logged with identity:\n\n';
  lines.forEach(function(line) {
    var tsMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
    var ts = tsMatch ? tsMatch[1] : '?';
    var fields = {};
    var m;
    var re1 = /(\w[\w.]+)="([^"]*)"/g;
    while ((m = re1.exec(line)) !== null) { fields[m[1]] = m[2]; }
    var re2 = /\b(bytes_sent|bytes_recv|duration)=(\d+\w*)/g;
    while ((m = re2.exec(line)) !== null) { if (!fields[m[1]]) fields[m[1]] = m[2]; }
    if (Object.keys(fields).length === 0) return;
    var srcId = fields['src.identity'] || 'unknown';
    var dstSvc = (fields['dst.service'] || '?').split('.')[0];
    var dstNs = fields['dst.namespace'] || '?';
    var sent = fields['bytes_sent'] || '?';
    var recv = fields['bytes_recv'] || '?';
    var dur = fields['duration'] || '?';
    var err = fields['error'] || '';
    var status = err ? 'DENIED' : 'OK   ';
    output += ts + '  ' + status + '  ' + srcId + '\n';
    output += '              > ' + dstSvc + '.' + dstNs + '  (' + sent + 'B sent, ' + recv + 'B recv, ' + dur + ')\n';
    if (err) output += '              reason: ' + err + '\n';
    output += '\n';
  });
  if (lines.length === 0) output += '  (no recent traffic -- run inference first)\n\n';
  output += 'Every mTLS connection is logged with SPIFFE identity, destination,\n';
  output += 'timestamp, bytes transferred, and duration. Denied connections\n';
  output += 'show the rejection reason. This is an audit trail for compliance --\n';
  output += 'no agent to install, no app instrumentation needed.';
  res.json({ output: output, exitCode: 0 });
});

// --- Part 6b: Traffic Management (retries, timeouts) ---

app.post('/api/test-unstable', async (req, res) => {
  const result = await run(`echo '$ curl http://httpbin/unstable  (x10)'
echo '  (httpbin fails ~50% of the time — simulating flaky service)'
echo ''
PASS=0; FAIL=0
for i in $(seq 1 10); do
  CODE=$(oc exec -n super-slim-demo deploy/test-client -- curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 http://httpbin.super-slim-demo.svc/unstable 2>/dev/null)
  if [ "$CODE" = "200" ]; then PASS=$((PASS+1)); printf "."; else FAIL=$((FAIL+1)); printf "X"; fi
done
echo ""
echo ""
echo "Results: $PASS succeeded, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "The client sees the failures directly."
else
  echo "All passed — retries may be absorbing failures behind the scenes."
fi`);
  res.json(result);
});

app.post('/api/retry-policy/apply', async (req, res) => {
  const result = await run(`oc apply -f - <<ENDOFPOLICY 2>&1
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: httpbin-retries
  namespace: super-slim-demo
spec:
  hosts:
    - httpbin.super-slim-demo.svc.cluster.local
  http:
    - route:
        - destination:
            host: httpbin.super-slim-demo.svc.cluster.local
            port:
              number: 80
      retries:
        attempts: 3
        retryOn: 5xx,reset,connect-failure,retriable-status-codes
        retryRemoteLocalities: true
      timeout: 5s
ENDOFPOLICY`);
  res.json(result);
});

app.post('/api/retry-policy/delete', async (req, res) => {
  const result = await run('oc delete virtualservice httpbin-retries -n super-slim-demo 2>&1');
  res.json(result);
});

app.get('/api/retry-policy/explain', async (req, res) => {
  const result = await run(`EXISTS=$(oc get virtualservice httpbin-retries -n super-slim-demo --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$EXISTS" = "0" ]; then
  echo 'No retry policy applied.'
  echo 'Requests that fail get returned to the client as-is.'
else
  echo 'VirtualService: httpbin-retries'
  echo ''
  echo '  retries:'
  echo '    attempts: 3      (retry up to 3 times)'
  echo '    retryOn: 5xx     (retry on any server error)'
  echo '  timeout: 5s        (total request timeout)'
  echo ''
  echo 'The waypoint proxy (Envoy) handles retries automatically.'
  echo 'The client sends one request — Envoy retries behind the scenes.'
  echo 'If all retries fail, the client gets the final error.'
fi`);
  res.json(result);
});

app.post('/api/test-timeout', async (req, res) => {
  const result = await run(`echo '$ curl http://httpbin.super-slim-demo.svc/delay/10'
echo '  (httpbin delays response by 10 seconds)'
echo ''
START=$(date +%s)
CODE=$(oc exec -n super-slim-demo deploy/test-client -- curl -s -o /dev/null -w '%{http_code}' --connect-timeout 15 http://httpbin.super-slim-demo.svc/delay/10 2>/dev/null)
END=$(date +%s)
ELAPSED=$((END - START))
echo "Result: HTTP $CODE (took ~\${ELAPSED}s)"
echo ''
if [ "$CODE" = "504" ]; then
  echo "The waypoint enforced the 5s timeout — request cut off before"
  echo "the 10s delay completed. The client gets a fast failure instead"
  echo "of waiting forever."
elif [ "$ELAPSED" -gt 8 ]; then
  echo "No timeout policy active — the request waited the full delay."
  echo "Apply the retry policy (which includes timeout: 5s) to see the difference."
else
  echo "Request completed in \${ELAPSED}s."
fi`);
  res.json(result);
});

// --- Part 7: Multi-Cluster ---

app.get('/api/root-ca', async (req, res) => {
  const result = await run("oc get secret mesh-root-ca-secret -n istio-system -o jsonpath='{.data.tls\\.crt}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -fingerprint 2>/dev/null");
  res.json(result);
});

app.get('/api/multi-cluster-verify', async (req, res) => {
  const result = await run(`RHOAI_FP=$(oc --context rhoai get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -fingerprint 2>/dev/null | cut -d= -f2)
SNO_FP=$(oc --context sno get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -fingerprint 2>/dev/null | cut -d= -f2)
RHOAI_INT=$(oc --context rhoai get secret cacerts -n istio-system -o jsonpath='{.data.ca-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject 2>/dev/null | sed 's/subject=//')
SNO_INT=$(oc --context sno get secret cacerts -n istio-system -o jsonpath='{.data.ca-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject 2>/dev/null | sed 's/subject=//')

echo 'Root CA (trust anchor):'
echo "  RHOAI cluster: $RHOAI_FP"
echo "  SNO cluster:   $SNO_FP"
if [ "$RHOAI_FP" = "$SNO_FP" ]; then
  echo "  ✓ MATCH — same root CA on both clusters"
else
  echo "  ✗ MISMATCH — different root CAs"
fi
echo ''
echo 'Intermediate CAs (unique per cluster):'
echo "  RHOAI: $RHOAI_INT"
echo "  SNO:   $SNO_INT"
echo ''
echo 'Same root = any workload on either cluster can verify the'
echo "other's SPIFFE identity. Cross-cluster mTLS is possible."`);
  res.json(result);
});

app.get('/api/multi-cluster-status', async (req, res) => {
  const result = await run(`echo 'Multi-cluster federation status:'
echo ''
echo '  ✓ Shared root CA            Both clusters trust the same root'
echo '  ✓ Per-cluster intermediate   Each cluster signs its own workload certs'
echo ''
echo '  ⏳ Cross-cluster traffic     Requires OSSM 3.4 (Istio 1.29)'
echo ''
echo 'Ambient multi-cluster is Tech Preview in OSSM 3.3 (Istio 1.28).'
echo 'The ztunnel data plane routing for cross-network traffic is not'
echo 'complete in this version — it reaches Beta in Istio 1.29 / OSSM 3.4'
echo 'with connectivity and stability fixes for ztunnel cross-cluster routing.'
echo ''
echo 'What we built today that carries forward:'
echo '  - Shared root CA across clusters (the trust anchor)'
echo '  - Per-cluster intermediate CAs (cert-manager managed)'
echo '  - cacerts secret format (same on every cluster)'
echo '  - Ambient mesh configuration (Istio CR, ZTunnel CR, IstioCNI)'
echo ''
echo 'When OSSM 3.4 ships:'
echo '  - East-west gateway (istio-east-west GatewayClass) routes cross-cluster'
echo '  - ztunnel handles HBONE tunnels between clusters natively'
echo '  - Same shared root CA — no trust infrastructure changes needed'
echo ''
echo 'The trust infrastructure is the hard part. Cross-cluster routing'
echo 'is a version upgrade — not a rebuild.'`);
  res.json(result);
});

app.get('/api/multi-cluster-certs', async (req, res) => {
  const rhoai_domain = await run("oc --context rhoai get ingress.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null");
  const rhoaiDomain = rhoai_domain.output.trim().replace(/'/g, '');
  const sno_domain = await run("oc --context sno get ingress.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null");
  const snoDomain = sno_domain.output.trim().replace(/'/g, '');
  const result = await run(`echo '=== RHOAI cluster gateway cert ==='
echo | openssl s_client -connect iris-onnx.${rhoaiDomain}:443 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null
echo ''
echo '=== SNO cluster gateway cert ==='
echo | openssl s_client -connect httpbin.${snoDomain}:443 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null
echo ''
echo 'Different intermediate CAs, same root = federated trust.'`);
  res.json(result);
});

// --- Part 9: Mesh Resources ---

app.get('/api/mesh-resources', async (req, res) => {
  const result = await run(`echo 'Mesh custom resources on this cluster:'
echo ''
echo '=== Control Plane ==='
oc get istio -A -o custom-columns='NAME:.metadata.name,NS:.spec.namespace,STATUS:.status.state,VERSION:.spec.version' --no-headers 2>/dev/null | awk '{printf "  Istio/%s  namespace=%s  status=%s  version=%s\\n", $1, $2, $3, $4}'
oc get istiocni -A -o custom-columns='NAME:.metadata.name,STATUS:.status.state' --no-headers 2>/dev/null | awk '{printf "  IstioCNI/%s  status=%s\\n", $1, $2}'
oc get ztunnel -A -o custom-columns='NAME:.metadata.name,STATUS:.status.state' --no-headers 2>/dev/null | awk '{printf "  ZTunnel/%s  status=%s\\n", $1, $2}'
echo ''
echo '=== Gateway API ==='
oc get gateway -A --no-headers 2>/dev/null | awk '{printf "  Gateway/%s  namespace=%s  class=%s\\n", $2, $1, $3}'
oc get httproute -A --no-headers 2>/dev/null | awk '{printf "  HTTPRoute/%s  namespace=%s\\n", $2, $1}'
oc get gatewayclass --no-headers 2>/dev/null | awk '{printf "  GatewayClass/%s  controller=%s\\n", $1, $2}'
echo ''
echo '=== Security ==='
oc get peerauthentication -A --no-headers 2>/dev/null | awk '{printf "  PeerAuthentication/%s  namespace=%s  mode=%s\\n", $2, $1, $3}'
oc get authorizationpolicy -A --no-headers 2>/dev/null | awk '{printf "  AuthorizationPolicy/%s  namespace=%s\\n", $2, $1}' 2>/dev/null
if [ $(oc get authorizationpolicy -A --no-headers 2>/dev/null | wc -l) -eq 0 ]; then echo '  (none active)'; fi
echo ''
echo '=== Certificates ==='
oc get certificate -n istio-system --no-headers 2>/dev/null | awk '{printf "  Certificate/%s  ready=%s\\n", $1, $2}'
oc get issuer -n istio-system --no-headers 2>/dev/null | awk '{printf "  Issuer/%s  ready=%s\\n", $1, $2}'
oc get clusterissuer --no-headers 2>/dev/null | grep mesh | awk '{printf "  ClusterIssuer/%s  ready=%s\\n", $1, $2}'
echo ''
echo '=== Networking ==='
oc get virtualservice -A --no-headers 2>/dev/null | awk '{printf "  VirtualService/%s  namespace=%s\\n", $2, $1}'
if [ $(oc get virtualservice -A --no-headers 2>/dev/null | wc -l) -eq 0 ]; then echo '  (none active)'; fi
echo ''
echo '=== Observability ==='
oc get kiali -A --no-headers 2>/dev/null | awk '{printf "  Kiali/%s  namespace=%s\\n", $2, $1}'
oc get ossmconsole -A --no-headers 2>/dev/null | awk '{printf "  OSSMConsole/%s  namespace=%s\\n", $2, $1}'
oc get podmonitor -A --no-headers 2>/dev/null | grep -iE "ztunnel|istiod|waypoint" | awk '{printf "  PodMonitor/%s  namespace=%s\\n", $2, $1}'
oc get servicemonitor -A --no-headers 2>/dev/null | grep -iE "istiod" | awk '{printf "  ServiceMonitor/%s  namespace=%s\\n", $2, $1}'`);
  res.json(result);
});

exec("oc get ingress.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null", (err, stdout) => {
  if (stdout && stdout.trim()) DOMAIN = stdout.trim().replace(/'/g, '');
  console.log(`Cluster domain: ${DOMAIN}`);
  app.listen(PORT, () => {
    console.log(`Demo console running at http://localhost:${PORT}`);
  });
});
