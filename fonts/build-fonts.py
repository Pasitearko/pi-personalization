"""Rebuild the existing family: only A-Z/a-z italic; upstream files stay untouched."""
from pathlib import Path
import sys, json, copy, hashlib, shutil
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
import fontTools
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.merge import Merger
from fontTools.pens.recordingPen import DecomposingRecordingPen

import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True, help='Directory containing the four upstream MapleMono-NF-CN TTF files')
args = parser.parse_args()
SOURCE = args.source.resolve()
OUTPUT = ROOT / 'fonts'
TEMP = ROOT / 'build-temp'
FAMILY = 'Studio Latin Italic NF CN'
PS_FAMILY = 'StudioLatinItalicNFCN'
LATIN = set(range(0x41, 0x5b)) | set(range(0x61, 0x7b))
OUTPUT.mkdir(exist_ok=True)
TEMP.mkdir(exist_ok=True)
for name in ['Regular', 'Italic', 'Bold', 'BoldItalic']:
    if not (SOURCE / f'MapleMono-NF-CN-{name}.ttf').is_file():
        parser.error(f'Missing upstream font: MapleMono-NF-CN-{name}.ttf')


def subset_to(source, codepoints, target):
    font = TTFont(source)
    options = subset.Options()
    options.layout_features = ['*']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.name_legacy = True
    options.hinting = True
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=codepoints)
    sub.subset(font)
    font.save(target)
    font.close()


def rename(font, style, bold, italic):
    replacements = {
        1: FAMILY, 2: style, 3: f'{PS_FAMILY};1.001;{style.replace(" ", "")}',
        4: f'{FAMILY} {style}', 5: 'Version 1.001; letters-only italic; derived from Maple Mono v8.0-beta.3',
        6: f'{PS_FAMILY}-{style.replace(" ", "")}', 16: FAMILY, 17: style,
        18: f'{FAMILY} {style}', 21: FAMILY, 22: style,
    }
    for record in list(font['name'].names):
        if record.nameID in replacements:
            font['name'].setName(replacements[record.nameID], record.nameID, record.platformID, record.platEncID, record.langID)
    for name_id, value in replacements.items():
        font['name'].setName(value, name_id, 3, 1, 0x409)
        font['name'].setName(value, name_id, 1, 0, 0)
    flags = font['OS/2'].fsSelection & ~((1 << 0) | (1 << 5) | (1 << 6) | (1 << 9))
    font['OS/2'].fsSelection = flags | (int(italic) << 0) | (int(bold) << 5) | (int(not bold and not italic) << 6)
    font['head'].macStyle = (font['head'].macStyle & ~3) | int(bold) | (int(italic) << 1)
    font['post'].italicAngle = -10.084518432617188 if italic else 0
    font['post'].isFixedPitch = 1
    font['hhea'].caretSlopeRise = 1000 if italic else 1
    font['hhea'].caretSlopeRun = 178 if italic else 0
    font['head'].fontRevision = 1.001
    font.recalcTimestamp = False
    font['head'].modified = 3874089601  # Fixed timestamp for reproducible local builds.
    if 'DSIG' in font: del font['DSIG']


def outline(font, glyph, glyph_set):
    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[glyph].draw(pen)
    return pen.value


reports = []
for bold, upright_style, italic_style in [(False, 'Regular', 'Italic'), (True, 'Bold', 'BoldItalic')]:
    upright_path = SOURCE / f'MapleMono-NF-CN-{upright_style}.ttf'
    italic_path = SOURCE / f'MapleMono-NF-CN-{italic_style}.ttf'
    upright = TTFont(upright_path)
    italic = TTFont(italic_path)
    uc, ic = upright.getBestCmap(), italic.getBestCmap()
    latin = set(ic) & LATIN
    # Keep every original non-Latin codepoint and any Latin point absent in Italic.
    nonlatin = set(uc) - latin
    ufile, ifile = TEMP / f'upright-{upright_style}.ttf', TEMP / f'latin-{italic_style}.ttf'
    subset_to(upright_path, nonlatin, ufile)
    subset_to(italic_path, latin, ifile)
    merged = Merger().merge([str(ufile), str(ifile)])
    # First input retains CJK/icon/box hinting. FontTools deliberately removes
    # second-input glyph hints to avoid incompatible CVT/function references.
    # Preserve the original terminal line metrics and style weight explicitly.
    for attr in ['ascent', 'descent', 'lineGap']:
        setattr(merged['hhea'], attr, getattr(upright['hhea'], attr))
    for attr in ['sTypoAscender', 'sTypoDescender', 'sTypoLineGap', 'usWinAscent', 'usWinDescent', 'usWeightClass']:
        setattr(merged['OS/2'], attr, getattr(upright['OS/2'], attr))
    for style, style_italic in [(upright_style, False), ('Bold Italic' if bold else 'Italic', True)]:
        variant = copy.deepcopy(merged)
        rename(variant, style, bold, style_italic)
        target = OUTPUT / f'{PS_FAMILY}-{style.replace(" ", "")}.ttf'
        variant.save(target)
        check = TTFont(target, checkChecksums=2)
        cmap = check.getBestCmap()
        assert set(cmap) == (set(uc) | latin), 'Character coverage changed'
        assert check['head'].unitsPerEm == upright['head'].unitsPerEm
        for cp, glyph in cmap.items():
            expected_font = italic if cp in latin else upright
            expected_glyph = expected_font.getBestCmap()[cp]
            # All character advances must match the official upright font.
            if cp in uc:
                assert check['hmtx'][glyph][0] == upright['hmtx'][uc[cp]][0], f'Advance changed at U+{cp:04X}'
            assert check['hmtx'][glyph] == expected_font['hmtx'][expected_glyph], f'Metrics changed at U+{cp:04X}'
        sets = [check.getGlyphSet(), upright.getGlyphSet(), italic.getGlyphSet()]
        sample = set(range(0x20, 0x7f)) | {ord(c) for c in '中文排版终端测试粗体传统字形日本語かな한국어éÀü'} | {0x2500,0x2502,0x250c,0x2510,0x2514,0x2518,0x251c,0x2524,0x252c,0x2534,0x253c,0xf120,0xf15b,0xf07c,0xe0a0,0xf121,0xf013}
        checked = 0
        for cp in sample & set(cmap):
            expected = italic if cp in latin else upright
            glyph_set = sets[2] if cp in latin else sets[1]
            assert outline(check, cmap[cp], sets[0]) == outline(expected, expected.getBestCmap()[cp], glyph_set), f'Outline changed at U+{cp:04X}'
            checked += 1
        row = {'file':target.name, 'family':FAMILY, 'style':style, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes':target.stat().st_size, 'codepoints':len(cmap), 'latinCodepoints':len(latin), 'outlinesChecked':checked, 'allCharacterAdvancesMatchOriginal':True, 'latinHinting':'removed safely by fontTools merger', 'nonLatinHinting':'preserved', 'lineMetricsPreserved':True}
        reports.append(row)
        print(f'Built and verified {target.name}: {len(cmap)} characters, {checked} outlines', flush=True)
        check.close()
        variant.close()
    merged.close()
    upright.close()
    italic.close()

shutil.copy2(SOURCE / 'LICENSE.txt', OUTPUT / 'LICENSE.txt')
(ROOT / 'font-metadata.json').write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf-8')
(ROOT / 'build-report.json').write_text(json.dumps({'fontTools':fontTools.__version__, 'basedOn':'Maple Mono NF CN v8.0-beta.3', 'family':FAMILY, 'version':'1.001', 'latinRanges':['U+0041-005A','U+0061-007A'], 'fonts':reports}, ensure_ascii=False, indent=2), encoding='utf-8')
shutil.rmtree(TEMP)
