"""Verify the original SQLite trace and both disk states without runtime imports."""
import csv
import hashlib
import io
import json
import sqlite3
import sys
from pathlib import Path

folder = Path(sys.argv[1]).resolve(strict=True)
db = sqlite3.connect((folder / 'runtime.sqlite').as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
run, = db.execute('select * from runs')
first, second = db.execute('select * from attempts order by created_at')
analysis, = db.execute('select * from analyses')
repair, = db.execute('select * from repairs')
assert run['status'] == 'completed'
assert (run['attempts_used'], run['tool_calls_used']) == (2, 2)
assert len({row['task_id'] for row in [run, first, second, analysis, repair]}) == 1
assert first['attempt_id'] != second['attempt_id'] == repair['attempt_id']
assert repair['analysis_id'] == analysis['analysis_id']
assert analysis['status'] == 'proposed' and analysis['consumed_at'] is not None
assert repair['status'] == 'settled' and json.loads(repair['outcome_json'])['succeeded']
assert json.loads(analysis['result_json'])['repair'] == json.loads((folder/'response.json').read_bytes())
assert json.loads(first['outcome_json'])['status'] == json.loads(second['outcome_json'])['status'] == 'succeeded'
a, b = [json.loads(x['verification_json']) for x in (first, second)]
assert [a['status'], b['status']] == ['fail', 'pass']
assert a['verifierId'] == b['verifierId'] == 'csv-source-output' and a['verifierVersion'] == b['verifierVersion'] == '1'
pre = json.loads((folder / 'before.json').read_bytes())
assert pre['attempt']['attempt_id'] == first['attempt_id']
before = bytes.fromhex(pre['outputHex'])
source = (folder / 'workspace' / 'input.csv').read_bytes()
after = (folder / 'workspace' / 'output.csv').read_bytes()
assert before == b'id,name\n\n' and source == after == b'id,name\n'
assert list(csv.reader(io.StringIO(after.decode('utf8')))) == [['id', 'name']]
sha = lambda data: hashlib.sha256(data).hexdigest()
assert a['evidenceRefs'][0].endswith(sha(source)) and a['evidenceRefs'][1].endswith(sha(before))
assert b['evidenceRefs'][0].endswith(sha(source)) and b['evidenceRefs'][1].endswith(sha(after))
assert json.loads(repair['candidate_json'])['arguments']['expectedSha256'] == sha(before)
events = list(db.execute("select sequence, kind, attempt_id, payload_json from events order by sequence"))
reads = [e['sequence'] for e in events if e['kind']=='io_observed' and json.loads(e['payload_json']).get('operation')=='readFileSync' and json.loads(e['payload_json']).get('path','').endswith('output.csv')]
ends = [e['sequence'] for e in events if e['kind']=='outcome_recorded']
starts = [e['sequence'] for e in events if e['kind']=='dispatch_started']
assert all(any(start < event < end for event in reads) for start,end in zip(starts,ends,strict=True))
print(json.dumps(dict(task=run['task_id'], attempts=[first['attempt_id'],second['attempt_id']], analysis=analysis['analysis_id'],repair=repair['repair_id'],outcomes=[a['reason'],b['reason']],input_sha256=sha(source),failed_sha256=sha(before),final_sha256=sha(after),dispatch_events=starts,outcome_events=ends,output_reads=reads),indent=2))
db.close()
