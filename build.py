#!/usr/bin/env python3
"""おてつだい ちょきん：組み立て
- src/core.js（きまり）を index.html の CORE の欄に書き写す
- src/core.js ＋ src/gas.js をつないで gas/Code.gs を作る（GAS に貼るのはこれ）
使い方: python3 build.py   （src を直したら毎回これを実行）
"""
import hashlib
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
core = (HERE / 'src/core.js').read_text(encoding='utf-8').rstrip() + '\n'
gas = (HERE / 'src/gas.js').read_text(encoding='utf-8').rstrip() + '\n'

START = '/* ==== CORE:START（src/core.js を build.py が書き写す。ここは直接直さない） ==== */\n'
END = '/* ==== CORE:END ==== */'
html_path = HERE / 'index.html'
html = html_path.read_text(encoding='utf-8')
pat = re.compile(re.escape(START) + r'.*?' + re.escape(END), re.S)
if not pat.search(html):
    raise SystemExit('index.html に CORE の欄が見つかりません')
html = pat.sub(lambda m: START + core + END, html, count=1)
html_path.write_text(html, encoding='utf-8')

out = HERE / 'gas/Code.gs'
out.parent.mkdir(exist_ok=True)
code = ('// おてつだい ちょきん（GAS）。build.py が src/core.js と src/gas.js から作ったファイル。直すときは src の方を直す\n\n'
        + core + '\n' + gas)
out.write_text(code, encoding='utf-8')
print('index.html を更新 / gas/Code.gs を作成',
      f'（{len(code.splitlines())}行・sha1 {hashlib.sha1(code.encode("utf-8")).hexdigest()[:12]}）')
