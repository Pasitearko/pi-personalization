import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const modules = resolve(process.argv[2] || process.env.PI_TEST_MODULES || new URL('../node_modules',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
const require = createRequire(join(modules, 'test.cjs'));
const { createJiti } = require('jiti');
const alias = Object.fromEntries(['pi-coding-agent','pi-tui','pi-ai','pi-agent-core'].flatMap(name =>
  ['@earendil-works','@mariozechner'].map(scope => [`${scope}/${name}`,join(modules,'@earendil-works',name,'dist/index.js')])));
const jiti = createJiti(import.meta.url, { alias, fsCache: false });
const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions");
const sdk = await jiti.import(alias['@earendil-works/pi-coding-agent']);
sdk.initTheme('dark');
const tui = await jiti.import(alias['@earendil-works/pi-tui']);
const alps = await jiti.import(join(root,'../node_modules/alps-pi/src/features/chrome-frame/patch.ts'));
const extension = await jiti.import(join(root,'frame-click-toggle/index.ts'));
const width = 68;
const ui = { requestRender() {} };
const plain = tui.stripTerminalSequences;
function tool(definition, name='read') {
  const item = new sdk.ToolExecutionComponent(name, 'call-fixture', {path:'中文目录/文件.ts'}, {}, definition, ui, process.cwd());
  item.updateResult({content:[{type:'text',text:Array.from({length:38},(_,i)=>`第${i+1}行 some content 中文 ${'x'.repeat(i%7)}`).join('\n')}],details:undefined,isError:false},false);
  return item;
}
function event(item,x,y,extra={}) {
  const lines=item.render(width);
  return {type:'click',button:'left',x,y,screenX:x+11,screenY:y+7,width,height:lines.length,shift:false,alt:false,ctrl:false,clickCount:1,...extra};
}
function countToggles(item) {
  let count=0;
  const original=item.setExpanded;
  item.setExpanded=function(value){count++;return original.call(this,value);};
  return ()=>count;
}
function lifecycle() {
  const handlers=new Map(),commands=new Map(),notifications=[];
  extension.default({on:(name,handler)=>handlers.set(name,handler),registerCommand:(name,command)=>commands.set(name,command)});
  const ctx={hasUI:true,mode:'tui',ui:{notify:(...args)=>notifications.push(args)}};
  handlers.get('session_start')({},ctx);
  handlers.get('resources_discover')({},ctx);
  return {handlers,commands,ctx,notifications,stop:()=>handlers.get('session_shutdown')({},ctx)};
}
alps.enablePatch();
const state=alps.getGlobalPatchState();
state.config.settings.chromeFrame.toolCompactMode='compact';
state.config.settings.chromeFrame.compactEditTool=false;
state.config.settings.chromeFrame.assistantFrame=true;
const live=lifecycle();
try {
  await test('collapsed and expanded frames: EVERY visible cell toggles exactly once',()=>{
    for(const expanded of [false,true]) {
      const probe=tool(); probe.setExpanded(expanded);
      const height=probe.render(width).length;
      for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
        const item=tool();item.setExpanded(expanded);const calls=countToggles(item);
        const result=item.handleMouse(event(item,x,y));
        assert.ok(result?.handled,`unhandled at ${expanded}:${x},${y}`);
        assert.equal(item.expanded,!expanded,`wrong state at ${x},${y}`);
        assert.equal(calls(),1,`duplicate toggle at ${x},${y}`);
      }
    }
  });
  await test('REAL Pi tool renderers: compact header, body and borders expand, then collapse',async()=>{
    const renderers = [];
    for(const name of ['read','bash','edit','write']) {
      const exported=await jiti.import(join(modules,`@earendil-works/pi-coding-agent/dist/core/tools/renderers/${name}.js`));
      renderers.push([name,name==='bash'?exported.createShellRenderers('$'):exported[`${name}Renderers`]]);
    }
    const {codemodeRenderers}=await jiti.import(join(modules,'@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js'));
    renderers.push(['codemode',codemodeRenderers]);
    for(const [name,definition] of renderers) for(const point of [[0,0],[7,0],[0,1],[3,1],[width-1,1]]) {
      const item=tool(definition,name);const calls=countToggles(item);
      item.handleMouse(event(item,...point));
      assert.equal(calls(),1,`${name} at ${point}: first click did not expand`);
      assert.equal(item.expanded,true);
      item.handleMouse(event(item,0,0));
      assert.equal(calls(),2,`${name}: second click did not collapse`);
      assert.equal(item.expanded,false);
    }
  });
  await test('compact passive nested Containers and Boxes never dispatch to hidden native coordinates',()=>{
    const leaf=new tui.Text('passive content',0,0);
    const box=new tui.Box(1,1);box.addChild(leaf);
    const container=new tui.Container();container.addChild(box);
    const item=tool({renderCall:()=>container,renderResult:()=>new tui.Text('result',0,0)});
    for(const point of [[0,0],[4,1],[width-1,1]]) {
      item.setExpanded(false);const e=event(item,...point);
      const before=container.mouseLayout;
      assert.equal(extension.handleFrameMouse(item,e,'tool',()=>{throw new Error('lossy native dispatch');})?.handled,true);
      assert.equal(item.expanded,true);assert.equal(container.mouseLayout,before);
    }
  });
  await test('compact interactive descendants protect body clicks but leave header and border expandable',()=>{
    let childCalls=0;
    const button={render:()=>['button'],invalidate(){},handleMouse(){childCalls++;return {handled:true};}};
    const container=new tui.Container();container.addChild(button);
    const item=tool({renderCall:()=>container,renderResult:()=>new tui.Text('result',0,0)});
    const calls=countToggles(item);
    assert.equal(item.handleMouse(event(item,4,1)),undefined);
    assert.equal(childCalls,0,'hidden control received unmappable event');assert.equal(calls(),0);
    assert.equal(item.handleMouse(event(item,0,0))?.handled,true);
    assert.equal(calls(),1);assert.equal(item.expanded,true);
    item.setExpanded(false);const before=calls();
    assert.equal(item.handleMouse(event(item,0,1))?.handled,true);
    assert.equal(calls(),before+1);assert.equal(childCalls,0);
  });
  await test('press/release/drag/wheel never toggle; modifiers and consecutive clicks do not fold',()=>{
    const item=tool();const calls=countToggles(item);
    for(const type of ['press','release','drag','move','wheel']) item.handleMouse(event(item,5,1,{type}));
    for(const extra of [{ctrl:true},{shift:true},{alt:true},{button:'right'},{button:'middle'},{clickCount:2},{clickCount:3}]) item.handleMouse(event(item,5,1,extra));
    assert.equal(calls(),0);
  });
  await test('outside bounds, hidden, narrow, stale resize and unknown render versions fail closed',()=>{
    const item=tool();const calls=countToggles(item);
    const e=event(item,0,0);
    for(const extra of [{x:-1},{x:width},{y:-1},{y:e.height},{width:width+1},{height:e.height+1},{width:7}]) item.handleMouse({...e,...extra});
    assert.equal(calls(),0);
    const metadata=Object.getOwnPropertyDescriptor(item.render,Symbol.for('alps.pi.wrappedRender.v2'));
    item.render=()=>[];
    item.handleMouse(e);
    assert.equal(calls(),0);
    assert.ok(metadata);
    const unknown=function(){return [];};
    Object.defineProperty(unknown,Symbol.for('alps.pi.wrappedRender.v2'),{value:{version:19}});
    item.render=unknown;
    assert.equal(extension.frameGeometry(item,e,'tool'),undefined);
    const images=tool();images.setExpanded(true);images.imageComponents=[{}];
    assert.equal(extension.frameGeometry(images,event(images,3,1),'tool').rows,undefined);
  });
  await test('no finished/partial result means no expansion of a pending tool',()=>{
    const item=new sdk.ToolExecutionComponent('read','pending',{path:'x'}, {},undefined,ui,process.cwd());
    const calls=countToggles(item);item.handleMouse(event(item,0,0));assert.equal(calls(),0);
  });
  await test('edit frames use normal native geometry even while other tools are compact',()=>{
    const item=tool(undefined,'edit');
    assert.ok(extension.frameGeometry(item,event(item,5,1),'tool').rows);
    const calls=countToggles(item);item.handleMouse(event(item,0,0));assert.equal(calls(),1);
  });
  await test('expanded custom child controls receive transformed cell coordinates first',()=>{
    let clicked=0,presses=0;
    const button={render:()=>['独立按钮'],invalidate(){},handleMouse(e){
      if(e.type==='press'){presses++;return undefined;}
      if(e.type==='click'){assert.equal(e.x,1);assert.equal(e.y,0);clicked++;return {handled:true};}
    }};
    const item=tool({renderCall:()=>button,renderResult:()=>new tui.Text('result',0,0)});
    item.setExpanded(true);const calls=countToggles(item);const lines=item.render(width);
    const row=lines.findIndex(line=>plain(line).includes('独立按钮'));
    assert.ok(row>0);
    item.handleMouse(event(item,4,row,{type:'press'}));
    item.handleMouse(event(item,4,row));
    assert.equal(presses,1);assert.equal(clicked,1);assert.equal(calls(),0);
  });
  await test('THINK frame toggles from header, body, whitespace and borders, but ordinary text does not',()=>{
    const message={role:'assistant',content:[{type:'thinking',thinking:'思考过程\n'+('detail '.repeat(40))}],timestamp:1000,stopReason:'stop'};
    for(const hidden of [true,false]) for(const point of [[0,0],[7,0],[0,1],[3,1],[width-1,1]]) {
      const item=new sdk.AssistantMessageComponent(message,hidden);
      const result=item.handleMouse(event(item,...point));assert.ok(result?.handled);
      const actual=item.thinkingVisibilityOverrides.get(0)??item.hideThinkingBlock;
      assert.equal(actual,!hidden);
    }
    const normal=new sdk.AssistantMessageComponent({...message,content:[{type:'text',text:'ordinary assistant body'}]},false);
    assert.equal(normal.handleMouse(event(normal,0,0)),undefined);
  });
  await test('mixed text/thinking preserves native thinking area and does not collapse the whole answer',()=>{
    const item=new sdk.AssistantMessageComponent({role:'assistant',content:[{type:'thinking',thinking:'think here'},{type:'text',text:'answer here'}],timestamp:1000,stopReason:'stop'},false);
    const lines=item.render(width);
    const y=lines.findIndex(line=>plain(line).includes('think here'));
    assert.ok(extension.frameGeometry(item,event(item,3,y),'thinking').rows);
    assert.ok(item.handleMouse(event(item,3,y))?.handled);
    assert.equal(item.thinkingVisibilityOverrides.get(0),true);
    assert.equal(item.handleMouse(event(item,0,0)),undefined);
  });
  await test('compaction frame border, expanded body and padding all toggle',()=>{
    for(const expanded of [false,true]) {
      const item=new sdk.CompactionSummaryMessageComponent({tokensBefore:12000,summary:'summary 中文\n'+('long text '.repeat(90))});
      item.setExpanded(expanded);const calls=countToggles(item);
      const e=event(item,width-1,0);item.handleMouse(e);assert.equal(item.expanded,!expanded);assert.equal(calls(),1);
    }
  });
  await test('timestamps decorator stays compatible and does not change geometry',async()=>{
    const timestamps=await jiti.import(join(root,'message-timestamps/index.ts'));
    const item=tool();const lines=item.render(width);
    const changed=timestamps.addHeaderTimestamp(lines,width,'10/07 11:20:00');
    assert.equal(changed.length,lines.length);
    const original=item.render.bind(item);
    const decorated=w=>timestamps.addHeaderTimestamp(original(w),w,'10/07 11:20:00');
    Object.defineProperty(decorated,Symbol.for('alps.pi.wrappedRender.v2'),Object.getOwnPropertyDescriptor(item.render,Symbol.for('alps.pi.wrappedRender.v2')));
    item.render=decorated;
    assert.ok(item.handleMouse(event(item,0,0))?.handled);assert.equal(item.expanded,true);
  });
  function screen(item,options={}) {
    const terminal={columns:width,rows:15,write(){},hideCursor(){},showCursor(){}};
    const result=new tui.TuiAltScreen(terminal,false,undefined,{copyOnSelect:false,...options});
    result.stopped=false;result.altScreenActive=true;result.requestRender=()=>{};
    result.addChild(item);result.doRender();return result;
  }
  await test('REAL fullscreen mouse press-release on header toggles once; drag selects without folding',()=>{
    const item=tool();const calls=countToggles(item);const s=screen(item);
    const y=s.previousScreen.findIndex(line=>plain(line).startsWith('╭─ '));assert.ok(y>=0);
    s.handleMouseEvent({button:0,x:5,y,release:false});assert.equal(calls(),0);
    s.handleMouseEvent({button:0,x:5,y,release:true});assert.equal(calls(),1);
    s.doRender();
    const body=s.previousScreen.findIndex(line=>plain(line).includes('第'));
    assert.ok(body>=0);
    s.handleMouseEvent({button:0,x:3,y:body,release:false});
    s.handleMouseEvent({button:32,x:13,y:body,release:false});
    s.handleMouseEvent({button:0,x:13,y:body,release:true});
    assert.equal(calls(),1);assert.ok(s.getActiveSelectionText());
    s.stopSelectionAutoScroll();
  });
  await test('REAL fullscreen bash/codemode frames expand from header and collapse from scrolled body',async()=>{
    const {createShellRenderers}=await jiti.import(join(modules,'@earendil-works/pi-coding-agent/dist/core/tools/renderers/bash.js'));
    const {codemodeRenderers}=await jiti.import(join(modules,'@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js'));
    for(const [name,definition] of [['bash',createShellRenderers('$')],['codemode',codemodeRenderers]]) {
      const item=tool(definition,name);const calls=countToggles(item);const s=screen(item);
      const header=s.previousScreen.findIndex(line=>plain(line).startsWith('╭─ '));assert.ok(header>=0);
      s.handleMouseEvent({button:0,x:0,y:header,release:false});
      s.handleMouseEvent({button:0,x:0,y:header,release:true});
      assert.equal(calls(),1,`${name}: fullscreen header click`);assert.equal(item.expanded,true);
      s.doRender();
      const row=s.previousScreen.findIndex(line=>plain(line).includes('第'));
      assert.ok(row>=0,`${name}: expanded result is visible`);
      s.handleMouseEvent({button:0,x:0,y:row,release:false});
      s.handleMouseEvent({button:0,x:0,y:row,release:true});
      assert.equal(calls(),2,`${name}: fullscreen body border click`);assert.equal(item.expanded,false);
      s.stopSelectionAutoScroll();
    }
  });
  await test('REAL fullscreen OSC8 HTTP and file links retain priority; no browser is launched',()=>{
    const opened=[];
    const target='https://example.com/';
    const item=tool();
    const original=item.render;
    const render=function(w){const lines=original.call(this,w);const cache=this[Symbol.for('alps.pi.renderCache.v9')];
      const body='│ '+`\x1b]8;;${target}\x1b\\`+'link'+`\x1b]8;;\x1b\\`+' '.repeat(w-8)+' │';
      cache.lines=[lines[0],body,lines.at(-1)];return cache.lines;};
    Object.defineProperty(render,Symbol.for('alps.pi.wrappedRender.v2'),Object.getOwnPropertyDescriptor(original,Symbol.for('alps.pi.wrappedRender.v2')));
    item.render=render;const calls=countToggles(item);const s=screen(item,{openUrl:url=>opened.push(url)});
    const y=s.previousScreen.findIndex(line=>plain(line).includes('link'));
    assert.ok(y>=0);
    s.handleMouseEvent({button:0,x:3,y,release:false});s.handleMouseEvent({button:0,x:3,y,release:true});
    assert.deepEqual(opened,[target]);assert.equal(calls(),0);
    // Verify the visible OSC8 span itself never folds, regardless of URI scheme.
    const fileEvent=event(item,3,1);
    const cache=item[Symbol.for('alps.pi.renderCache.v9')];
    cache.lines[1]=cache.lines[1].replace(target,'file:///C:/中文目录/文件.txt');
    assert.equal(extension.handleFrameMouse(item,fileEvent,'tool'),undefined);
    // Ctrl clicks are never repurposed into folding, including file-link gestures.
    item.handleMouse(event(item,0,0,{ctrl:true}));assert.equal(calls(),0);
  });
  await test('REAL fullscreen neighboring frames are independent; partially visible expanded frame still toggles',()=>{
    const first=tool(),second=tool();const one=countToggles(first),two=countToggles(second);
    const s=screen(first);s.addChild(second);s.doRender();
    const headers=s.previousScreen.map((line,y)=>plain(line).startsWith('╭─ ')?y:-1).filter(y=>y>=0);
    assert.equal(headers.length,2);
    s.handleMouseEvent({button:0,x:0,y:headers[1],release:false});
    s.handleMouseEvent({button:0,x:0,y:headers[1],release:true});
    assert.equal(one(),0);assert.equal(two(),1);
    const long=tool();long.setExpanded(true);const calls=countToggles(long);const partial=screen(long);
    assert.equal(partial.previousScreen.some(line=>plain(line).startsWith('╭─ ')),false,'frame header is scrolled out');
    const row=partial.previousScreen.findIndex(line=>plain(line).includes('第'));
    assert.ok(row>=0);
    partial.handleMouseEvent({button:0,x:4,y:row,release:false});
    partial.handleMouseEvent({button:0,x:4,y:row,release:true});
    assert.equal(calls(),1);assert.equal(long.expanded,false);
  });
  await test('narrow windows, Chinese wrapping and resize recalculate geometry from the latest render',()=>{
    for(const w of [8,12,24,39,100]) for(const expanded of [false,true]) {
      const item=tool();item.setExpanded(expanded);const lines=item.render(w);const calls=countToggles(item);
      item.handleMouse({type:'click',button:'left',x:w-1,y:lines.length-1,screenX:w-1,screenY:lines.length-1,width:w,height:lines.length,ctrl:false,alt:false,shift:false,clickCount:1});
      assert.equal(calls(),1,`width ${w}, expanded ${expanded}`);
    }
  });
  await test('/off restores behavior, /on re-enables, repeated bind is idempotent',async()=>{
    await live.commands.get('frame-clicks').handler('off',live.ctx);
    const item=tool();item.handleMouse(event(item,0,0));assert.equal(item.expanded,false);
    await live.commands.get('frame-clicks').handler('on',live.ctx);
    live.handlers.get('session_start')({},live.ctx);
    live.handlers.get('resources_discover')({},live.ctx);
    const calls=countToggles(item);item.handleMouse(event(item,0,0));assert.equal(calls(),1);
  });
  await test('shutdown restores inherited descriptor, does not overwrite another owner, reload installs once',()=>{
    const prototype=sdk.BashExecutionComponent.prototype;
    const foreign=()=>undefined;
    prototype.handleMouse=foreign;
    live.stop();assert.equal(prototype.handleMouse,foreign);delete prototype.handleMouse;
    assert.equal(Object.hasOwn(sdk.ToolExecutionComponent.prototype.handleMouse,Symbol.for('pi.frame-click-toggle.owner.v1')),false);
    const next=lifecycle();const item=tool();const calls=countToggles(item);
    item.handleMouse(event(item,0,0));assert.equal(calls(),1);next.stop();
    assert.equal(Object.hasOwn(prototype,'handleMouse'),false);
  });
} finally {
  live.stop();alps.disablePatch();
}
