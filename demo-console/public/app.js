async function api(method, path) {
  const btn = event?.target;
  if (btn) btn.classList.add('running');
  try {
    const res = await fetch(path, { method });
    const data = await res.json();
    return data;
  } catch (e) {
    return { output: `Error: ${e.message}`, exitCode: 1 };
  } finally {
    if (btn) btn.classList.remove('running');
  }
}

function showOutput(id, data) {
  const el = document.getElementById(id);
  const text = typeof data === 'string' ? data : (data.output || JSON.stringify(data, null, 2));
  el.textContent = text.trim() || '(no output)';
  el.classList.add('visible');
  el.classList.toggle('error', data.exitCode > 0);
  el.classList.toggle('success-border', data.exitCode === 0);
}

async function runAction(path, outputId, method = 'GET') {
  const data = await api(method, path);
  showOutput(outputId, data);
}

function toggleSection(el) {
  el.closest('.section').classList.toggle('open');
}

async function refreshStatus() {
  try {
    const health = await (await fetch('/api/health')).json();
    const nodeLines = health.nodes.trim().split('\n').filter(l => l.trim());
    const allReady = nodeLines.every(l => l.includes('Ready'));
    document.getElementById('status-nodes').innerHTML =
      `<span class="status-dot ${allReady ? 'green' : 'red'}"></span>${nodeLines.length} nodes ${allReady ? 'Ready' : 'NOT READY'}`;

    const meshLines = health.mesh.trim().split('\n').filter(l => l.trim());
    const meshHealthy = meshLines.every(l => l.includes('Healthy') || l.includes('True'));
    document.getElementById('status-mesh').innerHTML =
      `<span class="status-dot ${meshHealthy ? 'green' : 'yellow'}"></span>${meshHealthy ? 'Healthy' : 'Degraded'}`;

    const podLines = health.pods.trim().split('\n').filter(l => l.trim());
    const podsRunning = podLines.filter(l => l.includes('Running')).length;
    document.getElementById('status-pods').innerHTML =
      `<span class="status-dot ${podsRunning > 0 ? 'green' : 'red'}"></span>${podsRunning} pods running`;

    const authz = await (await fetch('/api/authz-policy/status')).json();
    const policyActive = authz.active;
    document.getElementById('status-authz').innerHTML =
      `<span class="status-dot ${policyActive ? 'yellow' : 'green'}"></span>${policyActive ? 'ACTIVE (restricting access)' : 'None (open access)'}`;

    const retry = await (await fetch('/api/timeout-policy/status')).json();
    document.getElementById('status-retry').innerHTML =
      `<span class="status-dot ${retry.active ? 'yellow' : 'green'}"></span>${retry.active ? 'ACTIVE (5s timeout)' : 'None'}`;
  } catch (e) {
    document.getElementById('status-nodes').innerHTML =
      `<span class="status-dot red"></span>API unreachable`;
  }

  try {
    const sno = await (await fetch('/api/sno-status')).json();
    const snoNodes = sno.nodes.trim().split('\n').filter(l => l.trim());
    const snoReady = snoNodes.every(l => l.includes('Ready'));
    document.getElementById('status-sno-node').innerHTML =
      `<span class="status-dot ${snoReady && snoNodes.length > 0 ? 'green' : 'red'}"></span>${snoNodes.length > 0 ? (snoReady ? 'Ready' : 'NOT READY') : 'Unreachable'}`;

    const snoMeshLines = sno.mesh.trim().split('\n').filter(l => l.trim());
    const snoMeshOk = snoMeshLines.length > 0 && snoMeshLines.every(l => l.includes('Healthy') || l.includes('True'));
    document.getElementById('status-sno-mesh').innerHTML =
      `<span class="status-dot ${snoMeshOk ? 'green' : snoMeshLines.length > 0 ? 'yellow' : 'red'}"></span>${snoMeshOk ? 'Healthy' : snoMeshLines.length > 0 ? 'Degraded' : 'No mesh'}`;

    const snoPodLines = sno.pods.trim().split('\n').filter(l => l.trim());
    const snoRunning = snoPodLines.filter(l => l.includes('Running')).length;
    document.getElementById('status-sno-pods').innerHTML =
      `<span class="status-dot ${snoRunning > 0 ? 'green' : 'red'}"></span>${snoRunning > 0 ? snoRunning + ' pods running' : 'No pods'}`;
  } catch (e) {
    document.getElementById('status-sno-node').innerHTML =
      `<span class="status-dot red"></span>Unreachable`;
  }
}

async function runInferAndShowLogs() {
  await runAction('/api/infer', 'out-1a', 'POST');
  setTimeout(() => runAction('/api/ztunnel-logs', 'out-1b'), 2000);
}

async function loadDomain() {
  try {
    const res = await fetch('/api/domain');
    const { domain } = await res.json();
    document.getElementById('link-kiali').href = `https://kiali-istio-system.${domain}`;
    document.getElementById('link-console').href = `https://console-openshift-console.${domain}/ossmconsole/graph`;
  } catch (e) {}
}

loadDomain();
refreshStatus();
setInterval(refreshStatus, 5000);
