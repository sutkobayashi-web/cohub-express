// OR-Tools VRP ソルバー Node 連携層
// VPS の Python venv (/opt/cohub/ortools-venv) を child_process で呼ぶ
const { spawn } = require('child_process');
const path = require('path');

const PY = process.env.ORTOOLS_PY || '/opt/cohub/ortools-venv/bin/python3';
const SCRIPT = path.join(__dirname, 'ortools_solver.py');

function solveVRP(payload, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: (opts.timeoutSec || 60) * 1000,
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ortools_solver exit ${code}: ${err.slice(0, 500)}`));
      }
      try {
        const j = JSON.parse(out);
        if (err) j._stderr = err.slice(0, 500);
        resolve(j);
      } catch (e) {
        reject(new Error('ortools_solver output not JSON: ' + out.slice(0, 200) + ' / stderr: ' + err.slice(0, 200)));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

module.exports = { solveVRP };
