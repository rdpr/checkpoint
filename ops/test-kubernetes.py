#!/usr/bin/env python3
"""Real Helm/kind acceptance with isolated cluster, kubeconfig and PVCs."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

source = Path(__file__).resolve().parent.parent
kind = os.environ.get('KIND_BIN', 'kind')
kubectl = os.environ.get('KUBECTL_BIN', 'kubectl')
helm = os.environ.get('HELM_BIN', 'helm')
cluster = f'pw-acceptance-{os.getpid()}'
image = os.environ.get('TEST_IMAGE', f'checkpoint-kube-test:{os.getpid()}')
with tempfile.TemporaryDirectory(prefix='pw-kind-') as temporary:
    directory = Path(temporary)
    env = dict(os.environ, KUBECONFIG=str(directory/'kubeconfig'))
    def run(command, **kwargs):
        return subprocess.run(command, env=env, check=True, text=True, **kwargs)
    def k(*args, **kwargs):
        return run([kubectl, '--context', 'kind-'+cluster, *args], **kwargs)
    def app(*args, **kwargs):
        return k('exec', '-i', 'checkpoint-0', '-c', 'app', '--', *args, **kwargs)
    try:
        if 'TEST_IMAGE' not in os.environ:
            run(['docker','build','-t',image,str(source)])
        run([kind,'create','cluster','--name',cluster,'--kubeconfig',env['KUBECONFIG'],'--wait','180s'])
        run([kind,'load','docker-image',image,'--name',cluster])
        repository, tag = image.rsplit(':',1)
        run([helm,'install','checkpoint',str(source/'deploy/kubernetes'),'--kube-context','kind-'+cluster,
             '--set',f'image.repository={repository}','--set-string',f'image.tag={tag}',
             '--set','origin=https://checkpoint.example.test','--set','storage.accessMode=ReadWriteOnce',
             '--set','storage.dataSize=1Gi','--set','storage.backupSize=1Gi'])
        k('wait','--for=jsonpath={.status.phase}=Running','pod/checkpoint-0','--timeout=180s')
        # Wait for the process's liveness, not readiness: bootstrap is required for readiness.
        app('node','-e',"let n=0; const t=setInterval(async()=>{try {const r=await fetch('http://127.0.0.1:4310/livez');if(r.ok){clearInterval(t);process.exit(0)}} catch{} if(++n>60)process.exit(1)},1000)")
        app('node','--import','tsx','server/operator.ts','bootstrap',input=json.dumps({'name':'Kubernetes owner','email':'kube@example.test','password':secrets.token_urlsafe(24)}))
        k('rollout','status','statefulset/checkpoint','--timeout=120s')
        app('python3','ops/container.py','backup')
        backup=app('python3','-c',"from pathlib import Path; print(next(Path('/backups').glob('manual-*.sqlite')))",capture_output=True).stdout.strip()
        app('python3','ops/container.py','verify-backup',backup)
        # A normal restart must retain initialized SQLite and become ready again.
        k('delete','pod','checkpoint-0','--wait=true')
        k('rollout','status','statefulset/checkpoint','--timeout=180s')
        # Real restore through the documented maintenance pod after detaching the writer.
        k('scale','statefulset/checkpoint','--replicas=0')
        k('wait','--for=delete','pod/checkpoint-0','--timeout=120s')
        manifest=(source/'deploy/kubernetes/restore-pod.example.yaml').read_text().replace('ghcr.io/rdpr/checkpoint:0.1.0',image)
        k('apply','-f','-',input=manifest)
        k('wait','--for=condition=Ready','pod/checkpoint-restore','--timeout=180s')
        k('exec','checkpoint-restore','--','python3','ops/container.py','restore',backup,'--confirm-restore')
        k('delete','pod','checkpoint-restore','--wait=true')
        k('scale','statefulset/checkpoint','--replicas=1')
        k('rollout','status','statefulset/checkpoint','--timeout=180s')
        app('python3','ops/container.py','health')
        print('Kubernetes Helm deployment, bootstrap, backup, pod restart and PVC restore passed.')
    finally:
        # No default/current context or pre-existing cluster is touched.
        subprocess.run([kubectl,'--kubeconfig',env['KUBECONFIG'],'--context','kind-'+cluster,'get','pods','-o','wide'],text=True)
        subprocess.run([kind,'delete','cluster','--name',cluster,'--kubeconfig',env['KUBECONFIG']],env=env,check=True)
