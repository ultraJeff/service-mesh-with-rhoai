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
  const result = await run("echo 'The model runtime listens on plain HTTP — no TLS, no mutual auth:'; echo; oc exec -n super-slim-demo deploy/iris-onnx-predictor -c kserve-container -- ss -tlnp 2>/dev/null | grep -E 'State|8080'; echo; echo 'Without the mesh, any pod on the cluster can call it with plain curl:'; echo '  curl http://iris-onnx-predictor.super-slim-demo.svc:80/v2/models/iris-onnx'");
  res.json(result);
});

// --- Part 2: Ambient Mesh ---

app.get('/api/ztunnel-pods', async (req, res) => {
  const result = await run('oc get pods -n ztunnel 2>/dev/null; echo "\\n--- istio-cni ---"; oc get pods -n istio-cni 2>/dev/null');
  res.json(result);
});

app.get('/api/namespace-labels', async (req, res) => {
  const result = await run("oc get ns super-slim-demo -o jsonpath='{.metadata.labels}' 2>/dev/null | python3 -m json.tool");
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
  const result = await run(`echo 'The CA chain is 5 cert-manager resources applied in order:'
echo ''
echo '1. ClusterIssuer/mesh-selfsigned        (bootstrap - self-signed)'
echo '     ↓ signs'
echo '2. Certificate/mesh-root-ca             (Root CA, 10yr TTL)'
echo '     → creates Secret: mesh-root-ca-secret'
echo '     ↓'
echo '3. Issuer/mesh-root-ca-issuer           (can sign using the root CA)'
echo '     ↓ signs'
echo '4. Certificate/mesh-intermediate-ca     (Intermediate CA, 5yr TTL)'
echo '     → creates Secret: mesh-intermediate-ca-secret'
echo '     ↓'
echo '5. Issuer/mesh-intermediate-ca-issuer   (signs everything below)'
echo '     ↓ signs'
echo '     ├── Certificate/mesh-gateway-cert  (gateway TLS, 90d, auto-renewed)'
echo '     └── Istio cacerts secret           (SPIFFE workload certs, 24h rotation)'
echo ''
echo 'In production: replace step 1-2 with your corporate PKI root CA.'
echo 'Everything else stays the same.'`);
  res.json(result);
});

app.get('/api/cacerts-verify', async (req, res) => {
  const result = await run("oc get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -issuer 2>/dev/null");
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
  res.json(result);
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
    - kind: Service
      group: ""
      name: iris-onnx-predictor
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/istio-system/sa/mesh-gateway-istio"`;
  const result = await run(`echo '${policy}' | oc apply -f - 2>&1`);
  res.json(result);
});

app.post('/api/authz-policy/delete', async (req, res) => {
  const result = await run('oc delete authorizationpolicy iris-allow-gateway-only -n super-slim-demo 2>&1');
  res.json(result);
});

app.post('/api/test-external', async (req, res) => {
  const result = await run(`curl --cacert /tmp/mesh-root-ca.pem -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://iris-onnx.${DOMAIN}/v2/models/iris-onnx 2>/dev/null`);
  const code = result.output.trim();
  res.json({ output: `External (mesh gateway) → iris-onnx: HTTP ${code}`, exitCode: code === '200' ? 0 : 1 });
});

app.post('/api/test-pod-to-pod', async (req, res) => {
  const result = await run("oc exec -n super-slim-demo test-notebook-0 -- curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 http://iris-onnx-predictor.super-slim-demo.svc:80/v2/models/iris-onnx 2>&1");
  const code = result.output.trim();
  res.json({ output: `Notebook → iris-onnx (pod-to-pod): HTTP ${code}`, exitCode: code === '200' ? 0 : 1 });
});

// --- Part 7: Multi-Cluster ---

app.get('/api/root-ca', async (req, res) => {
  const result = await run("oc get secret mesh-root-ca-secret -n istio-system -o jsonpath='{.data.tls\\.crt}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -fingerprint 2>/dev/null");
  res.json(result);
});

app.get('/api/multi-cluster-verify', async (req, res) => {
  const result = await run(`echo '=== RHOAI Cluster ==='
oc --context rhoai get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -fingerprint 2>/dev/null
oc --context rhoai get secret cacerts -n istio-system -o jsonpath='{.data.ca-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject 2>/dev/null
echo ''
echo '=== SNO Cluster ==='
oc --context sno get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject -fingerprint 2>/dev/null
oc --context sno get secret cacerts -n istio-system -o jsonpath='{.data.ca-cert\\.pem}' 2>/dev/null | base64 -d | openssl x509 -noout -subject 2>/dev/null
echo ''
echo 'Same root CA fingerprint = cross-cluster trust established.'
echo 'Each cluster has its own intermediate CA for workload certs.'`);
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

exec("oc get ingress.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null", (err, stdout) => {
  if (stdout && stdout.trim()) DOMAIN = stdout.trim().replace(/'/g, '');
  console.log(`Cluster domain: ${DOMAIN}`);
  app.listen(PORT, () => {
    console.log(`Demo console running at http://localhost:${PORT}`);
  });
});
