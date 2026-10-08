import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const modules=resolve(process.argv[2]||process.env.PI_TEST_MODULES||new URL('../node_modules',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const require=createRequire(join(modules,'test.cjs'));
const {createJiti}=require('jiti');
const alias=Object.fromEntries(['pi-coding-agent','pi-tui','pi-ai','pi-agent-core'].flatMap(name=>['@earendil-works','@mariozechner'].map(scope=>[`${scope}/${name}`,join(modules,'@earendil-works',name,'dist/index.js')])));
const jiti=createJiti(import.meta.url,{alias,fsCache:false});
const root=join(dirname(dirname(fileURLToPath(import.meta.url))), 'extensions');
const sdk=await jiti.import(alias['@earendil-works/pi-coding-agent']);sdk.initTheme('dark');
const tui=await jiti.import(alias['@earendil-works/pi-tui']);
const alps=await jiti.import(join(root,'../node_modules/alps-pi/src/features/chrome-frame/patch.ts'));
const copy=await jiti.import(join(root,'clean-frame-copy/index.ts'));
const clicks=await jiti.import(join(root,'frame-click-toggle/index.ts'));
const timestamps=await jiti.import(join(root,'message-timestamps/index.ts'));
const chrome=await jiti.import(join(root,'../node_modules/alps-pi/src/features/chrome-frame/chrome.ts'));
const plain=tui.stripTerminalSequences;
const original=tui.TuiAltScreen.prototype.getActiveSelectionText;
const originalHighlight=tui.TuiAltScreen.prototype.applySelection;
// Decode inverse-video per terminal CELL, including ANSI resets/colors and wide graphemes.
function highlightedCells(line) {
  const cells=[];let inverse=false,col=0,index=0;
  const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
  while(index<line.length) {
    const ansi=/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\))/.exec(line.slice(index));
    if(ansi) {
      if(ansi[0].startsWith('\x1b[')&&ansi[0].endsWith('m')) {
        const codes=ansi[0].slice(2,-1).split(';').map(n=>n===''?0:Number(n.split(':')[0]));
        for(let i=0;i<codes.length;i++){const n=codes[i];if((n===38||n===48)&&!ansi[0].slice(2,-1).includes(':')){i+=codes[i+1]===2?4:codes[i+1]===5?2:0;continue;}if(n===0||n===27)inverse=false;else if(n===7)inverse=true;}
      }
      index+=ansi[0].length;continue;
    }
    const end=line.indexOf('\x1b',index);const text=line.slice(index,end<0?line.length:end);
    for(const {segment} of segmenter.segment(text)){for(let i=0;i<tui.visibleWidth(segment);i++)cells[col++]=inverse;}
    index+=text.length;if(!text.length)index++;
  }
  return cells;
}
const ui={requestRender(){}};
function lifecycle(extension,ctx={hasUI:true,mode:'tui',ui:{notify(){}}}) {
  const handlers=new Map(),commands=new Map();extension.default({on:(n,h)=>handlers.set(n,h),registerCommand:(n,c)=>commands.set(n,c)});
  handlers.get('session_start')({},ctx);
  return {handlers,commands,ctx,stop:()=>handlers.get('session_shutdown')({},ctx)};
}
function tool(text='first line\n    indented code\n\n├─ actual tree\n│ actual content\n| table | value |\nlast line') {
  const item=new sdk.ToolExecutionComponent('read','fixture',{path:'中文.txt'},{},undefined,ui,process.cwd());
  item.updateResult({content:[{type:'text',text}],isError:false},false);item.setExpanded(true);return item;
}
function screen(items,columns=70,rows=120,options={}) {
  const terminal={columns,rows,write(){},hideCursor(){},showCursor(){}};
  const s=new tui.TuiAltScreen(terminal,false,undefined,{copyOnSelect:false,...options});
  s.stopped=false;s.altScreenActive=true;s.requestRender=()=>{};s.flash=()=>{};
  for(const item of items)s.addChild(item);if(options.layoutRoot)s.setLayoutRoot(options.layoutRoot);s.doRender();return s;
}
function scrollBox(s) {
  const sv=s.currentLayout.primaryScrollView;
  function walk(b){if(b.scrollView===sv)return b;for(const c of b.children){const result=walk(c);if(result)return result;}}
  return walk(s.currentLayout.root);
}
function source(s){return scrollBox(s).scrollContentLines;}
function select(s,startRow,endRow,startCol=0,endCol=69,reverse=false) {
  const sv=s.currentLayout.primaryScrollView;
  const a={scrollView:sv,row:startRow,col:startCol},b={scrollView:sv,row:endRow,col:endCol};
  s.selectionAnchor=reverse?b:a;s.selectionFocus=reverse?a:b;return s.getActiveSelectionText();
}
function bodyRow(s,text){const i=source(s).findIndex(line=>plain(line).includes(text));assert.ok(i>=0,text);return i;}
function edges(s){const lines=source(s).map(plain);return [lines.findIndex(line=>line.startsWith('╭─ ')),lines.findLastIndex(line=>line.startsWith('╰'))];}
alps.enablePatch();const state=alps.getGlobalPatchState();state.config.settings.chromeFrame.assistantFrame=true;
state.config.settings.chromeFrame.toolCompactMode='compact';state.config.settings.chromeFrame.compactEditTool=false;
const live=lifecycle(copy);
try {
  await test('real ALPS tool: remove only generated outer borders; preserve indentation, tree, tables and blank lines',()=>{
    const s=screen([tool()]);const [top,bottom]=edges(s);const text=select(s,top,bottom);
    assert.ok(text.startsWith('TOOL'));assert.ok(text.includes('\n     indented code\n\n ├─ actual tree\n │ actual content\n | table | value |\n last line'));
    assert.equal(text.includes('╭'),false);assert.equal(text.includes('╰'),false);assert.equal(text.split('\n').some(line=>line.endsWith(' │')),false);
  });
  await test('partial selection preserves selected substring and reverse selection is identical',()=>{
    const s=screen([tool('abcdefghij\n    second')]);const y=bodyRow(s,'abcdefghij');
    assert.equal(select(s,y,y,5,8),'cdef');assert.equal(select(s,y,y,5,8,true),'cdef');
    assert.equal(select(s,y,y,0,8),' abcdef');
  });
  await test('cross-frame selection removes both frames and preserves intervening blank spacer',()=>{
    const s=screen([tool('ONE'),new tui.Spacer(1),tool('TWO')]);const [top,bottom]=edges(s);
    const text=select(s,top,bottom);assert.ok(text.includes('ONE\n\nTOOL'));assert.ok(text.includes('TWO'));
    assert.equal(/[╭╮╰╯]/.test(text),false);
  });
  await test('USER and ASSISTANT frames clean without adding folding or changing selection highlights',()=>{
    const user=new sdk.UserMessageComponent('user words');
    const assistant=new sdk.AssistantMessageComponent({role:'assistant',content:[{type:'text',text:'answer words'}],timestamp:1000,stopReason:'stop'},false);
    const s=screen([user,assistant]);const before=[...s.previousScreen];const [top,bottom]=edges(s);
    const text=select(s,top,bottom);assert.ok(text.includes('user words'));assert.ok(text.includes('answer words'));
    assert.equal(/[╭╮╰╯]/.test(text),false);assert.deepEqual(s.previousScreen,before);
  });
  await test('frame-only selection stays active but performs no clipboard copy or last-answer fallback',async()=>{
    const copied=[];const s=screen([tool()],70,120,{copySelection:async text=>{copied.push(text);return true;}});
    const [top,bottom]=edges(s);assert.equal(select(s,bottom,bottom,0,69),'');assert.equal(s.hasActiveSelection(),true);
    assert.equal(await s.copyActiveSelectionToClipboard(),false);assert.deepEqual(copied,[]);
    assert.equal(select(s,top,top,0,2),'');assert.equal(s.hasActiveSelection(),true);
  });
  await test('title timestamp and bottom elapsed text are retained when actually selected',()=>{
    const item=tool('body');const render=item.render;
    const decorated=function(w){const lines=render.call(this,w);const bottom=chrome.renderNeonBox('tool',['body'],w,{fg:(_token,text)=>text},{elapsedText:'12s'}).at(-1);
      const cache=this[Symbol.for('alps.pi.renderCache.v9')];cache.lines=[...lines.slice(0,-1),bottom];return timestamps.addHeaderTimestamp(cache.lines,w,'10/07 12:34:56');};
    Object.defineProperty(decorated,Symbol.for('alps.pi.wrappedRender.v2'),Object.getOwnPropertyDescriptor(render,Symbol.for('alps.pi.wrappedRender.v2')));item.render=decorated;
    const s=screen([item]);const [top,bottom]=edges(s);const text=select(s,top,bottom);
    assert.ok(text.includes('10/07 12:34:56'));assert.ok(text.endsWith('\n12s'));assert.equal(/[╭╮╰╯]/.test(text),false);
    s.doRender();const bottomText=plain(s.previousScreen[bottom]);const start=bottomText.indexOf('12s');assert.ok(start>=0);
    assert.deepEqual(highlightedCells(s.previousScreen[bottom]).map((on,x)=>on?x:-1).filter(x=>x>=0),[start,start+1,start+2]);
    const header=plain(s.previousScreen[top]),stamp=header.indexOf('10/07 12:34:56');assert.ok(stamp>0);assert.equal(highlightedCells(s.previousScreen[top])[stamp],true);
  });
  await test('OSC8 HTTP/file links copy visible text only; no escape sequences, opening, or target injection',()=>{
    for(const url of ['https://example.com/','file:///C:/中文目录/file.txt']) {
      const item=tool('LINK visible');const render=item.render;
      const decorated=function(w){const lines=render.call(this,w);const cache=this[Symbol.for('alps.pi.renderCache.v9')];cache.lines=lines.map(line=>line.replace('LINK',`\x1b]8;;${url}\x1b\\LINK\x1b]8;;\x1b\\`));return cache.lines;};
      Object.defineProperty(decorated,Symbol.for('alps.pi.wrappedRender.v2'),Object.getOwnPropertyDescriptor(render,Symbol.for('alps.pi.wrappedRender.v2')));item.render=decorated;
      const s=screen([item]);const row=bodyRow(s,'LINK visible');const text=select(s,row,row);
      assert.equal(text,' LINK visible');assert.equal(text.includes('\x1b'),false);assert.equal(text.includes(url),false);
    }
  });
  await test('mixed framed/plain selection preserves literal diagrams and no-copy selection is unchanged',()=>{
    const s=screen([tool('framed'),new tui.Text('╭─ literal ─╮\n│ untouched │\n╰───────────╯',0,0)]);
    const text=select(s,0,source(s).length-1);assert.ok(text.includes('╭─ literal ─╮\n│ untouched │\n╰───────────╯'));
    assert.equal(text.startsWith('TOOL'),true);s.selectionAnchor=undefined;s.selectionFocus=undefined;assert.equal(s.getActiveSelectionText(),undefined);
  });
  await test('copies only the visible compact summary, never expands or exposes hidden result',()=>{
    const item=tool('SECRET-FIXTURE '.repeat(100));item.setExpanded(false);const s=screen([item]);const [top,bottom]=edges(s);
    const native=original;select(s,top,bottom);const raw=native.call(s);const text=s.getActiveSelectionText();
    assert.equal(item.expanded,false);assert.ok(text.length<raw.length);assert.equal(text.includes('SECRET-FIXTURE'),false);
  });
  await test('unknown or disabled frames and a stale same-width changed body keep the native text',()=>{
    const item=tool('before');const s=screen([item]);const [top,bottom]=edges(s);
    const cache=item[Symbol.for('alps.pi.renderCache.v9')];cache.lines=[...cache.lines];cache.lines[1]=cache.lines[1].replace('read','DIFF');
    assert.equal(select(s,top,bottom),original.call(s));
    alps.disablePatch();try {const bare=screen([tool('plain')]);assert.equal(select(bare,0,source(bare).length-1),original.call(bare));}finally{alps.enablePatch();}
  });
  await test('identical-looking literal frames in plain Text are NEVER cleaned',()=>{
    const text='╭─ ASSISTANT '+'─'.repeat(53)+'╮\n│ '+'literal body'.padEnd(66)+' │\n╰'+'─'.repeat(68)+'╯';
    const s=screen([new tui.Text(text,0,0)]);const lines=source(s);assert.equal(select(s,0,lines.length-1),original.call(s));
  });
  await test('unknown ALPS version, stale cache, disabled frame and overlay fail back to native extraction',()=>{
    for(const mode of ['version','cache','overlay']) {
      const item=tool();const s=screen([item]);const [top,bottom]=edges(s);
      if(mode==='version'){const render=item.render;const wrapper=w=>render.call(item,w);Object.defineProperty(wrapper,Symbol.for('alps.pi.wrappedRender.v2'),{value:{version:19}});item.render=wrapper;}
      if(mode==='cache')item[Symbol.for('alps.pi.renderCache.v9')].width++;
      if(mode==='overlay')s.hasOverlay=()=>true;
      assert.equal(select(s,top,bottom),original.call(s),mode);
    }
  });
  await test('narrow widths, Chinese and emoji use cell-based selection after resize',()=>{
    for(const width of [8,12,30,70]) {
      const s=screen([tool('中文 😀 👩‍💻 text\n  nested')],width);const [top,bottom]=edges(s);
      const text=select(s,top,bottom,0,width-1);assert.equal(/[╭╮╰╯]/.test(text),false,`width ${width}`);
      assert.ok(text.includes('中'));s.terminal.columns=width+5;s.doRender();
      const [a,b]=edges(s);assert.equal(/[╭╮╰╯]/.test(select(s,a,b,0,width+4)),false);
    }
  });
  await test('explicit padded Box and ScrollView/VStack layouts map frame coordinates correctly',()=>{
    const box=new tui.Box(2,1);box.addChild(tool('nested padded'));
    const scroll=new tui.ScrollView(new tui.VStack([box,tool('stacked')]),{primary:true,scrollbar:'hidden'});
    const s=screen([scroll],70,12,{layoutRoot:new tui.VStack([scroll])});const lines=source(s);const text=select(s,0,lines.length-1);
    assert.ok(text.includes('nested padded'));assert.ok(text.includes('stacked'));assert.equal(/[╭╮╰╯]/.test(text),false);
  });
  await test('off-screen content is cleaned via scroll content rows, not viewport row numbers',()=>{
    const s=screen([tool(Array.from({length:70},(_,i)=>`line-${i}`).join('\n'))],70,12);
    const [top,bottom]=edges(s);assert.ok(bottom>s.terminal.rows);const text=select(s,top,bottom);
    assert.ok(text.includes('line-0'));assert.ok(text.includes('line-69'));assert.equal(/[╭╮╰╯]/.test(text),false);
  });
  await test('native clipboard callback receives clean text and actual dragging still does not fold',async()=>{
    const fold=lifecycle(clicks);try{
      const item=tool('dragged text');let toggles=0;const set=item.setExpanded;item.setExpanded=function(v){toggles++;return set.call(this,v);};
      const copied=[];const s=screen([item],70,120,{copyOnSelect:true,copySelection:async text=>{copied.push(text);return true;}});
      const y=s.previousScreen.findIndex(line=>plain(line).includes('dragged text'));assert.ok(y>=0);
      s.handleMouseEvent({button:0,x:0,y,release:false});s.handleMouseEvent({button:32,x:25,y,release:false});s.handleMouseEvent({button:0,x:25,y,release:true});
      await new Promise(r=>setImmediate(r));assert.equal(toggles,0);assert.equal(copied.length,1);assert.equal(copied[0],' dragged text');s.stopSelectionAutoScroll();
    }finally{fold.stop();}
  });
  await test('whole-frame highlight: corners, horizontal lines, side rails and ALPS padding NEVER invert',()=>{
    const s=screen([tool('body\n    indent\n\n│ literal ─ box')]);const before=[...s.previousScreen];const [top,bottom]=edges(s);
    select(s,top,bottom);s.doRender();assert.deepEqual(s.previousScreen.map(plain),before.map(plain));
    for(let y=top;y<=bottom;y++) {
      const cells=highlightedCells(s.previousScreen[y]);const titleEnd=plain(before[top]).indexOf(' ──',3);assert.ok(titleEnd>3);
      const expected=y===top?new Set(Array.from({length:titleEnd-3},(_,i)=>i+3)):y===bottom?new Set():new Set(Array.from({length:66},(_,i)=>i+2));
      assert.deepEqual(cells.map((on,x)=>on?x:-1).filter(x=>x>=0),[...expected],`row ${y}`);
    }
    assert.ok(s.getActiveSelectionText().includes('│ literal ─ box'));
  });
  await test('border-only drag has zero highlighted cells, empty copy, and keeps the no-last-answer-fallback sentinel',()=>{
    const s=screen([tool()]);const [top,bottom]=edges(s);
    for(const [y,a,b] of [[top,0,2],[bottom,0,69],[bodyRow(s,'first line'),0,1],[bodyRow(s,'first line'),68,69]]) {
      assert.equal(select(s,y,y,a,b),'');s.doRender();assert.equal(highlightedCells(s.previousScreen[y]).some(Boolean),false);assert.equal(s.hasActiveSelection(),true);
    }
  });
  await test('128 deterministic forward/reverse selections highlight exactly the non-decoration selected cells',()=>{
    const s=screen([tool('中文😀 é 👩‍💻\n│ ─ literal\n    code')]);const [top,bottom]=edges(s);let seed=17;
    const rand=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
    for(let i=0;i<128;i++) {
      const a=top+rand(bottom-top+1),b=a+rand(bottom-a+1),left=rand(70),right=b===a?Math.min(69,left+1+rand(70-left)):rand(70);
      select(s,a,b,left,right,!!(i%2));s.doRender();const bounds=s.getSelectionBounds();
      assert.deepEqual(s.previousScreen.map(plain),originalHighlight.call(s,s.currentLayout.lines,s.currentLayout).map(plain),`visible Unicode cells ${i}`);
      for(let y=top;y<=bottom;y++) {
        const selected=y>=bounds.start.row&&y<=bounds.end.row?s.getSelectionColumns(s.previousScreen[y],y,bounds):{start:0,end:0};
        const titleEnd=plain(s.previousScreen[top]).indexOf(' ──',3);assert.ok(titleEnd>3);
        const expected=[];for(let x=selected.start;x<selected.end;x++)if(y===top?x>=3&&x<titleEnd:y!==bottom&&x>=2&&x<68)expected.push(x);
        assert.deepEqual(highlightedCells(s.previousScreen[y]).map((on,x)=>on?x:-1).filter(x=>x>=0),expected,`sample ${i}, row ${y}`);
      }
    }
  });
  await test('cross-frame highlighting excludes every drawn frame while preserving blank and literal text selections',()=>{
    const literal=new tui.Text('│ literal diagram ─ │',0,0);const s=screen([tool('ONE'),new tui.Spacer(1),literal,tool('TWO')]);const [top,bottom]=edges(s);
    select(s,top,bottom);s.doRender();
    for(let y=top;y<=bottom;y++) {const raw=plain(s.previousScreen[y]),cells=highlightedCells(s.previousScreen[y]);if(raw.startsWith('╭')||raw.startsWith('╰')||raw.startsWith('│  ')){assert.equal(cells[0],false);assert.equal(cells[69],false);}}
    const y=bodyRow(s,'literal diagram');assert.equal(highlightedCells(s.previousScreen[y])[0],true);assert.ok(s.getActiveSelectionText().includes('│ literal diagram ─ │'));
  });
  await test('scrolled explicit layouts clip highlight to viewport, keep fixed bars unchanged, and survive resize/new incoming layout',()=>{
    const box=new tui.Box(2,1);box.addChild(tool(Array.from({length:40},(_,i)=>`row-${i}`).join('\n')));
    const scroll=new tui.ScrollView(box,{primary:true,scrollbar:'hidden'});const root=new tui.VStack([new tui.Text('FIXED HEADER',0,0),scroll,new tui.Text('FIXED FOOTER',0,0)]);
    const s=screen([],70,12,{layoutRoot:root});scroll.scrollTo(8);s.doRender();select(s,0,source(s).length-1);s.doRender();
    for(const width of [70,35,80]) {
      s.terminal.columns=width;s.doRender();const b=scrollBox(s);
      for(let y=0;y<s.previousScreen.length;y++){const raw=plain(s.previousScreen[y]),cells=highlightedCells(s.previousScreen[y]);if(raw.includes('FIXED'))assert.equal(cells.some(Boolean),false);if(raw.includes('row-')){assert.equal(cells[b.rect.x+2],false);assert.equal(cells[b.rect.x+3],false);assert.equal(cells[b.rect.x+4],true);assert.equal(cells[b.rect.x+width-3],false);}}
    }
    s.selectionDragPointer={x:8,y:0};s.selectionAutoScrollDirection=-1;s.autoScrollSelection();s.doRender();s.stopSelectionAutoScroll();assert.equal(s.getActiveSelectionText().includes('╭'),false);
  });
  await test('styled code/search and OSC8 remain intact, ANSI resets never leak inverse into borders',()=>{
    const s=screen([tool('LINK code')]);const [top,bottom]=edges(s);select(s,top,bottom);
    const input=[...s.currentLayout.lines];const row=bodyRow(s,'LINK code');input[row]=input[row].replace('LINK',`\x1b]8;;https://example.com/\x1b\\\x1b[48;2;0;80;0mLINK\x1b[0m\x1b]8;;\x1b\\`);
    const result=s.applySelection(input,s.currentLayout);assert.deepEqual(result.map(plain),input.map(plain));assert.ok(result[row].includes('https://example.com/'));assert.ok(result[row].includes('\x1b[48;2;0;80;0m'));
    for(let y=top;y<=bottom;y++){const cells=highlightedCells(result[y]);assert.equal(cells[0],false);assert.equal(cells[69],false);}assert.equal(highlightedCells(result[row])[3],true);
  });
  await test('highlight conservatively matches native under overlays, stale cache, unknown renderer and mutated visible cells',()=>{
    for(const mode of ['overlay','cache','version','indicator']) {
      const item=tool();const s=screen([item]);const [top,bottom]=edges(s);select(s,top,bottom);const lines=[...s.currentLayout.lines];
      if(mode==='overlay')s.hasOverlay=()=>true;
      if(mode==='cache')item[Symbol.for('alps.pi.renderCache.v9')].width++;
      if(mode==='version'){const render=item.render;const wrapper=w=>render.call(item,w);Object.defineProperty(wrapper,Symbol.for('alps.pi.wrappedRender.v2'),{value:{version:19}});item.render=wrapper;}
      if(mode==='indicator')lines[top]=lines[top].replace('TOOL','WIDGET');
      const result=s.applySelection(lines,s.currentLayout),native=originalHighlight.call(s,lines,s.currentLayout);
      if(mode==='indicator')assert.equal(result[top],native[top]);else assert.deepEqual(result,native,mode);
    }
  });
  await test('literal look-alike frame highlight stays native and rendering without selection changes nothing',()=>{
    const s=screen([new tui.Text('╭─ TOOL '+'─'.repeat(61)+'╮\n│ literal │\n╰'+'─'.repeat(68)+'╯',0,0)]);
    const lines=[...s.currentLayout.lines];assert.deepEqual(s.applySelection(lines,s.currentLayout),lines);select(s,0,2);
    assert.deepEqual(s.applySelection(lines,s.currentLayout),originalHighlight.call(s,lines,s.currentLayout));assert.equal(highlightedCells(s.applySelection(lines,s.currentLayout)[0])[0],true);
  });
  await test('temporary off/on and shutdown/reload restore the exact original extraction method',async()=>{
    const s=screen([tool('body')]);const [top,bottom]=edges(s);select(s,top,bottom);let redraws=0;s.requestRender=()=>redraws++;
    await live.commands.get('clean-copy').handler('off',live.ctx);assert.equal(redraws,1);assert.equal(s.getActiveSelectionText(),original.call(s));assert.deepEqual(s.applySelection(s.currentLayout.lines,s.currentLayout),originalHighlight.call(s,s.currentLayout.lines,s.currentLayout));
    await live.commands.get('clean-copy').handler('on',live.ctx);assert.equal(redraws,2);assert.equal(/[╭╮╰╯]/.test(s.getActiveSelectionText()),false);
    const wrapper=tui.TuiAltScreen.prototype.getActiveSelectionText;live.handlers.get('session_start')({},live.ctx);assert.equal(tui.TuiAltScreen.prototype.getActiveSelectionText,wrapper);
    live.stop();assert.equal(tui.TuiAltScreen.prototype.getActiveSelectionText,original);assert.equal(tui.TuiAltScreen.prototype.applySelection,originalHighlight);
    const again=lifecycle(copy);assert.notEqual(tui.TuiAltScreen.prototype.getActiveSelectionText,original);again.stop();
  });
  await test('half-installation rolls copy back atomically; foreign highlight owner is preserved with paired native fallback',()=>{
    const define=Object.defineProperty;let refused=false;
    Object.defineProperty=function(object,key,descriptor){if(object===tui.TuiAltScreen.prototype&&key==='applySelection'&&!refused){refused=true;throw Error('fixture: reject highlight hook');}return define(object,key,descriptor);};
    let failed;try{failed=lifecycle(copy);}finally{Object.defineProperty=define;failed?.stop();}
    assert.equal(refused,true);assert.equal(tui.TuiAltScreen.prototype.getActiveSelectionText,original);assert.equal(tui.TuiAltScreen.prototype.applySelection,originalHighlight);
    const active=lifecycle(copy);const s=screen([tool('paired')]);const [top,bottom]=edges(s);select(s,top,bottom);
    const other=function(lines){return lines;};tui.TuiAltScreen.prototype.applySelection=other;
    assert.equal(s.getActiveSelectionText(),original.call(s));active.stop();assert.equal(tui.TuiAltScreen.prototype.applySelection,other);assert.equal(tui.TuiAltScreen.prototype.getActiveSelectionText,original);
    tui.TuiAltScreen.prototype.applySelection=originalHighlight;
  });
  await test('RPC/non-UI never hooks; another owner is not overwritten on shutdown',()=>{
    const rpc=lifecycle(copy,{hasUI:false,mode:'rpc',ui:{notify(){}}});assert.equal(tui.TuiAltScreen.prototype.getActiveSelectionText,original);rpc.stop();
    const active=lifecycle(copy);const other=function(){return 'other';};tui.TuiAltScreen.prototype.getActiveSelectionText=other;active.stop();assert.equal(tui.TuiAltScreen.prototype.getActiveSelectionText,other);tui.TuiAltScreen.prototype.getActiveSelectionText=original;
  });
}finally{live.stop();tui.TuiAltScreen.prototype.getActiveSelectionText=original;tui.TuiAltScreen.prototype.applySelection=originalHighlight;alps.disablePatch();}
