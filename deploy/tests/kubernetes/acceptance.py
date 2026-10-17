import json,subprocess,time,uuid,urllib.request,urllib.error,sys,hashlib,os
from pathlib import Path
BASE=os.environ.get('WALDEN_TEST_HTTP_A','http://localhost:18082')
SECOND=os.environ.get('WALDEN_TEST_HTTP_B','http://localhost:18083')
FIXTURE=os.environ.get('WALDEN_TEST_PROVIDER','http://localhost:18081')
ORIGIN=os.environ.get('WALDEN_TEST_ORIGIN','http://localhost:18080')
CONTEXT='kind-walden-selfhost-test'
KUBECONFIG=os.environ.get('KUBECONFIG')
if not KUBECONFIG or Path(KUBECONFIG).resolve()==Path.home()/'.kube/config':
 raise SystemExit('Set KUBECONFIG to the disposable cluster private kubeconfig.')
KUBE=['kubectl','--kubeconfig',KUBECONFIG,'--context',CONTEXT,'-n',os.environ.get('WALDEN_TEST_NAMESPACE','walden-validation')]
results=[]
def kubectl(*args):return subprocess.check_output(KUBE+list(args),text=True).strip()
def sql(query):return kubectl('exec','deploy/walden-postgres','--','psql','-U','postgres','-d','walden','-At','-c',query)
def http(path,body=None,base=BASE,headers=None):
 data=None if body is None else json.dumps(body).encode()
 req=urllib.request.Request(base+path,data=data,headers={'content-type':'application/json','origin':ORIGIN,**(headers or {})})
 with urllib.request.urlopen(req,timeout=30) as response:
  text=response.read().decode();return json.loads(text) if text else None

def wait_for(condition,description,timeout=70):
 stop=time.monotonic()+timeout
 while time.monotonic()<stop:
  value=condition()
  if value:return value
  time.sleep(.3)
 raise AssertionError('Timed out: '+description)
def mode(next):return http('/fixture/mode',{'mode':next},FIXTURE)
def turn(message):
 chat=http('/api/conversations',{'personaId':'thinking-partner'})
 req={'requestId':str(uuid.uuid4()),'conversationId':chat['id'],'branchId':chat['branchId'],'noteRevision':None,'message':message,'personaId':'thinking-partner'}
 started=http('/api/chat/turns',req)
 return chat,started['turnId']
def state(turn_id):return sql("SELECT status FROM turns WHERE id='%s'"%turn_id)
def events(turn_id,after=0):
 req=urllib.request.Request(SECOND+'/api/chat/turns/'+turn_id+'/events?after='+str(after),headers={'X-Walden-Turn-Protocol':'2'})
 with urllib.request.urlopen(req,timeout=90) as response: data=response.read().decode()
 ids=[int(line[4:]) for line in data.splitlines() if line.startswith('id: ')]
 assert ids==sorted(set(ids)),ids
 assert all(value>after for value in ids),ids
 return data,ids

def record(name,**evidence):
 value={'check':name,'passed':True,**evidence};results.append(value);print(json.dumps(value),flush=True)

for base in [BASE,SECOND]:
 with urllib.request.urlopen(base+'/health/ready') as response:assert response.status==200
account=http('/api/account/privacy');other=http('/api/account/privacy',base=SECOND)
assert account==other
assert int(sql("SELECT count(*) FROM users WHERE auth_provider='none'"))==1
record('two-http-replicas-share-default-account',ownerId=sql("SELECT id FROM users WHERE auth_provider='none'"))
note=http('/api/notes',{'markdown':'Kubernetes persisted note '+str(uuid.uuid4())})
assert any(row['id']==note['id'] for row in http('/api/notes',base=SECOND));record('cross-replica-note',noteId=note['id'])
mode('answer');chat,normal=turn('Answer this Kubernetes fixture question.')
wait_for(lambda:state(normal)=='completed','normal turn completion')
text,ids=events(normal);assert 'Kubernetes fixture answer.' in text and '[DONE]' in text

record('distributed-stream-completes',turnId=normal,eventCount=len(ids))
file_bytes=(Path(__file__).resolve().parents[3]/'apps/api/src/platform/node/documents/fixtures/paper.docx').read_bytes()
filename='paper.docx';mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
upload=http('/api/chat/attachments/'+chat['id']+'/initiate',{'name':filename,'mimeType':mime,'size':len(file_bytes)})
with urllib.request.urlopen(urllib.request.Request(upload['uploadUrl'],data=file_bytes,headers=upload['headers'],method='PUT'),timeout=30) as response:assert response.status in [200,201]
completed=http('/api/chat/attachments/'+chat['id']+'/'+upload['id']+'/complete',{'name':filename})
with urllib.request.urlopen(SECOND+'/api/chat/attachments/'+chat['id']+'/'+upload['id'],timeout=30) as response:assert response.read()==file_bytes
record('s3-presign-complete-cross-replica-download',attachmentId=upload['id'],sha256=hashlib.sha256(file_bytes).hexdigest())

mode('hold');chat,cancelled=turn('Hold this turn until it is stopped.')
wait_for(lambda: int(sql("SELECT count(*) FROM turn_events WHERE turn_id='%s' AND event_json LIKE '%%Partial%%'"%cancelled))>0,'cancel partial')
assert http('/api/chat/turns/'+cancelled+'/cancel',{},SECOND)['cancelled']
wait_for(lambda:state(cancelled)=='cancelled','durable remote cancellation',20)
text,ids=events(cancelled);assert '[DONE]' in text
record('cancel-from-other-http-replica',turnId=cancelled,eventCount=len(ids))
mode('hold');chat,recovered=turn('Recover this turn after the worker is killed.')
wait_for(lambda: int(sql("SELECT count(*) FROM turn_events WHERE turn_id='%s' AND event_json LIKE '%%Partial%%'"%recovered))>0,'recovery partial')
cursor=int(sql("SELECT coalesce(max(sequence),0) FROM turn_events WHERE turn_id='%s'"%recovered))
old=json.loads(kubectl('get','pods','-l','app.kubernetes.io/component=worker','-o','json'))
old_names=[item['metadata']['name'] for item in old['items']]
mode('answer')
for name in old_names:kubectl('delete','pod',name,'--grace-period=0','--force','--wait=false')
wait_for(lambda:state(recovered)=='completed','crashed worker recovery',110)
text,ids=events(recovered,cursor);assert '[DONE]' in text
assistant_count=int(sql("SELECT count(*) FROM messages WHERE turn_id='%s' AND role='assistant'"%recovered))
assert assistant_count==1,assistant_count
record('worker-crash-recovery-and-cursor-replay',turnId=recovered,killedWorkerPods=old_names,cursor=cursor,replayedEvents=len(ids),assistantMessages=assistant_count)
ledger=sql('SELECT version FROM walden_migrations ORDER BY version').splitlines()
record('migration-job-schema',migrations=ledger)
Path(os.environ.get('WALDEN_TEST_RESULTS','kubernetes-acceptance-results.json')).write_text(json.dumps(results,indent=2))
