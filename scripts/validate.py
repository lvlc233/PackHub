import json, sys, glob
import yaml
from jsonschema import Draft7Validator

schema = json.load(open('schema/packhub.v0.0.1.schema.json', encoding='utf-8'))
Draft7Validator.check_schema(schema)
v = Draft7Validator(schema)

files = sorted(glob.glob('examples/*/packhub.yaml'))
ok = True
for f in files:
    doc = yaml.safe_load(open(f, encoding='utf-8'))
    errs = sorted(v.iter_errors(doc), key=lambda e: list(e.path))
    if errs:
        ok = False
        print('FAIL', f)
        for e in errs:
            print('  -', '/'.join(map(str, e.path)) or '<root>', '::', e.message[:160])
    else:
        print('PASS', f, '|', doc['metadata']['name'], doc['metadata']['version'],
              '| resources:', len(doc['resources']))
print('SCHEMA_OK' if ok else 'SCHEMA_FAIL')
sys.exit(0 if ok else 2)
