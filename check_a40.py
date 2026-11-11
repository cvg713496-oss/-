import glob
import json

f = glob.glob('uploads/*a40628f8*full.json')[0]
data = json.load(open(f, encoding='utf-8'))
print(f"Total segments: {len(data)}")
for i, x in enumerate(data[:12]):
    orig = x.get('original', '').encode('ascii', 'backslashreplace').decode('ascii')
    print(f"#{i+1}: {x.get('start')} -> {x.get('end')}: {orig}")

