import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocumentString } from 'ladder-visualizer';
import { ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import { onEvent } from '../../../shared/runtime/events';
import { clearViewerCache } from '../../registry/viewer-cache';
import { clearAllTabStates, getCachedTabState } from './l5x/useTabs';
import { buildDocumentRecords, findDocumentRecord, findLocationRecord } from './l5x/document-model';
import L5XDocumentStatus from '../shared/L5XDocumentStatus';
import { parseL5XDocument } from '../shared/l5x-document';
import L5XFileViewer from './L5XFileViewer';

vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({ ReadTextFile: vi.fn() }));
vi.mock('../../../shared/runtime/events', () => ({ onEvent: vi.fn(() => vi.fn()) }));
vi.mock('../shared/ViewerHeader', () => ({ ViewerHeader: ({ extraContent }: { extraContent: React.ReactNode }) => <div>{extraContent}</div> }));
vi.mock('ladder-visualizer', async importOriginal => {
  const actual = await importOriginal<typeof import('ladder-visualizer')>();
  // Diagram geometry belongs to its existing renderer tests. Keep parser/source/text real.
  return { ...actual, VirtualizedLadderDiagram: () => <div>Ladder content</div>,
    FBDDiagram: ({ sheetIndex = 0, onSheetIndexChange }: { sheetIndex?: number; onSheetIndexChange?: (index: number) => void }) =>
      <div>Sheet {sheetIndex}<button onClick={() => onSheetIndexChange?.(sheetIndex + 1)}>Next sheet</button></div>,
  };
});

const filePath = '/repo/Source.L5X';
const fixture = (name: string) => readFileSync(`src/viewers/components/shared/__fixtures__/l5x/${name}.L5X`, 'utf8');
const sfc = (marker = 'original') => `<Routine Name="Flow" Type="SFC">\r\n  <!-- ${marker} -->\r\n  <SFCContent><Step ID="0"><Description><![CDATA[A < B & <script>source</script>]]></Description><Action><STContent>  A := 1;  </STContent></Action></Step></SFCContent>\r\n</Routine>`;
const program = (name: string) => `<Program Name="${name}"><Routines>${sfc(name)}</Routines></Program>`;
const wrap = (inner: string, type = 'Controller', name = 'C') => `<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="35.00" TargetType="${type}" TargetName="${name}"><Controller Name="C">${inner}</Controller></RSLogix5000Content>`;
const xmlText = () => screen.getByRole('region', { name: 'Flow XML source' }).querySelector('code')!.textContent;
const editor = () => EditorView.findFromDOM(screen.getByRole('textbox', { name: 'File content' }))!;
async function load(content: string) {
  vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content });
  const view = render(<L5XFileViewer filePath={filePath} />);
  await screen.findByRole('button', { name: 'Document' });
  return view;
}
function openDocument() { fireEvent.click(screen.getByRole('button', { name: 'Document' })); }
function overview() { return within(screen.getByRole('region', { name: 'Document export and source' })); }
function openRecord(title: string) { fireEvent.click(overview().getByRole('button', { name: title })); }

describe('L5X document source inspection', () => {
  beforeEach(() => {
    clearViewerCache();
    clearAllTabStates();
    vi.clearAllMocks();
  });

  it.each(['controller-rll-v35', 'program-rll-v35', 'routine-rll-v35', 'rung-rll-v35', 'tags-v35', 'datatype-v35', 'aoi-v35', 'module-v35'])(
    'selects the declared target family in %s', async name => {
      const content = fixture(name);
      const document = parseDocumentString(content, 'l5x').data!;
      const records = buildDocumentRecords(document);
      const targets = records.filter(record => record.group === 'Targets');
      expect(targets.map(record => record.path)).toEqual(document.targetIds);
      await load(content);
      if (document.source.targetType === 'Controller') {
        openDocument();
        fireEvent.click(overview().getByRole('button', { name: 'Targets' }));
        openRecord(targets[0].title);
      }
      expect(await screen.findByRole('heading', { level: 2, name: targets[0].title })).toBeVisible();
      const cached = getCachedTabState(filePath)!;
      expect(cached.tabs.find(tab => tab.id === cached.activeTabId)?.data).toMatchObject({ type: 'document', selection: targets[0].selection });
    });

  it('shows export metadata and distinguishes context and reference resources', async () => {
    await load(fixture('document-envelope-v35'));
    openDocument();
    expect(overview().getByRole('row', { name: 'Target type Routine' })).toBeVisible();
    expect(overview().getByRole('row', { name: 'Target count 1' })).toBeVisible();
    fireEvent.click(overview().getByRole('button', { name: 'Context' }));
    openRecord('Controller DocumentFixture / Dependency (Data type)');
    expect(screen.getByRole('row', { name: 'Role context' })).toBeVisible();
    openDocument();
    fireEvent.click(overview().getByRole('button', { name: 'References' }));
    openRecord('Controller DocumentFixture / ReferencedType (Data type)');
    expect(screen.getByRole('row', { name: 'Role reference' })).toBeVisible();
  });

  it.each(['program', 'AOI', 'standalone'])('renders supplied original %s SFC source', async owner => {
    const content = owner === 'AOI'
      ? wrap(`<AddOnInstructionDefinitions><AddOnInstructionDefinition Name="A"><Routines>${sfc()}</Routines></AddOnInstructionDefinition></AddOnInstructionDefinitions>`, 'AddOnInstructionDefinition', 'A')
      : wrap(`<Programs><Program Name="P"><Routines>${sfc()}</Routines></Program></Programs>`, owner === 'standalone' ? 'Routine' : 'Controller', owner === 'standalone' ? 'Flow' : 'C');
    await load(content);
    if (owner === 'program') {
      fireEvent.click(screen.getByRole('button', { name: 'Expand P' }));
      fireEvent.click(screen.getByRole('button', { name: 'Flow' }));
    } else if (owner === 'AOI') {
      fireEvent.click(screen.getByRole('button', { name: 'AOI A / Flow (Routine)' }));
    }
    expect(xmlText()).toBe(sfc());
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'View Raw' })[0]);
    await screen.findByRole('textbox', { name: 'File content' });
    expect(editor().state.sliceDoc()).toBe(content);
    expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps same-name routines distinct across owners, refresh, and cached reopen', async () => {
    const content = wrap(`<Programs>${program('P1')}${program('P2')}</Programs><AddOnInstructionDefinitions><AddOnInstructionDefinition Name="A"><Routines>${sfc('A')}</Routines></AddOnInstructionDefinition></AddOnInstructionDefinitions>`);
    const view = await load(content);
    for (const owner of ['P1', 'P2', 'A']) {
      openDocument();
      openRecord(`${owner === 'A' ? 'AOI' : 'Program'} ${owner} / Flow (Routine)`);
      expect(xmlText()).toBe(sfc(owner));
    }
    expect(screen.getAllByRole('tab', { name: /Flow/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('tab', { name: /P1 \/ Flow/ }));
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: content.replace(`${program('P1')}${program('P2')}`, `${program('P2')}${program('P1')}`) });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    await waitFor(() => expect(ReadTextFile).toHaveBeenCalledTimes(2));
    expect(xmlText()).toBe(sfc('P1'));
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    expect(await screen.findByRole('region', { name: 'Flow XML source' })).toBeVisible();
    expect(xmlText()).toBe(sfc('P1'));
    expect(ReadTextFile).toHaveBeenCalledTimes(2);
  });

  it.each(['program', 'routine', 'tag', 'rung'] as const)('retains %s source identity when its program UID survives a rename', kind => {
    const content = wrap('<Programs><Program Name="Original" UId="123"><Tags><Tag Name="Owned" TagType="Base" DataType="BOOL"/></Tags><Routines><Routine Name="Flow" Type="RLL"><RLLContent><Rung Number="0" Type="N"><Text>XIC(Owned);</Text></Rung></RLLContent></Routine></Routines></Program></Programs>');
    const before = buildDocumentRecords(parseDocumentString(content, 'l5x').data!);
    const selection = before.find(record => record.resource?.kind === kind)!.selection;
    const after = buildDocumentRecords(parseDocumentString(content.replace('Name="Original"', 'Name="Renamed"'), 'l5x').data!);
    expect(findDocumentRecord(after, selection)?.resource?.kind).toBe(kind);
  });

  it('keeps an open source tab through UID-preserving rename, name reuse and cached reopen', async () => {
    const original = `<Program Name="Original" UId="123"><Routines>${sfc('owned')}</Routines></Program>`;
    const view = await load(wrap(`<Programs>${original}</Programs>`));
    openDocument();
    openRecord('Program Original / Flow (Routine)');
    const renamed = original.replace('Name="Original"', 'Name="Renamed"');
    const replacement = `<Program Name="Original" UId="456"><Routines>${sfc('replacement')}</Routines></Program>`;
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: wrap(`<Programs>${replacement}${renamed}</Programs>`) });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    expect(await screen.findByRole('heading', { name: 'Program Renamed / Flow (Routine)' })).toBeVisible();
    expect(xmlText()).toBe(sfc('owned'));
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    expect(await screen.findByRole('heading', { name: 'Program Renamed / Flow (Routine)' })).toBeVisible();
    expect(xmlText()).toBe(sfc('owned'));
    openDocument();
    openRecord('Program Renamed / Flow (Routine)');
    expect(screen.getAllByRole('tab', { name: /Flow/ })).toHaveLength(1);
    expect(ReadTextFile).toHaveBeenCalledTimes(2);
  });

  it('keeps duplicate UID tabs distinct after a sibling disappears and the viewer reopens', async () => {
    const owned = (name: string) => `<Program Name="${name}" UId="123"><Routines>${sfc(name)}</Routines></Program>`;
    const view = await load(wrap(`<Programs>${owned('A')}${owned('B')}</Programs>`));
    for (const name of ['A', 'B']) {
      openDocument();
      openRecord(`Program ${name} / Flow (Routine)`);
      expect(xmlText()).toBe(sfc(name));
    }
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: wrap(`<Programs>${owned('B')}</Programs>`) });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    expect(await screen.findByRole('region', { name: 'Flow XML source' })).toBeVisible();
    expect(xmlText()).toBe(sfc('B'));
    fireEvent.click(screen.getByRole('tab', { name: /Program A \/ Flow/ }));
    expect(screen.getByText(/This source record is no longer available/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Flow XML source' })).not.toBeInTheDocument();
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    expect(await screen.findByText(/This source record is no longer available/)).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: /Program B \/ Flow/ }));
    expect(xmlText()).toBe(sfc('B'));
    openDocument();
    openRecord('Program B / Flow (Routine)');
    expect(screen.getAllByRole('tab', { name: /Flow/ })).toHaveLength(2);
  });

  it('distinguishes identical routine and owner names between program and AOI scopes', async () => {
    await load(wrap(`<Programs>${program('Shared')}</Programs><AddOnInstructionDefinitions><AddOnInstructionDefinition Name="Shared"><Routines>${sfc('AOI')}</Routines></AddOnInstructionDefinition></AddOnInstructionDefinitions>`));
    openDocument();
    openRecord('Program Shared / Flow (Routine)');
    expect(xmlText()).toBe(sfc('Shared'));
    openDocument();
    openRecord('AOI Shared / Flow (Routine)');
    expect(xmlText()).toBe(sfc('AOI'));
    expect(screen.getAllByRole('tab', { name: /Shared \/ Flow/ })).toHaveLength(2);
  });

  it('preserves FBD sheet selection when a declared routine target refreshes', async () => {
    const content = wrap('<Programs><Program Name="P"><Routines><Routine Name="Flow" Type="FBD"><FBDContent SheetSize="D" SheetOrientation="Landscape"><Sheet Number="1"/><Sheet Number="2"/></FBDContent></Routine></Routines></Program></Programs>', 'Routine', 'Flow');
    await load(content);
    fireEvent.click(screen.getByRole('button', { name: 'Next sheet' }));
    expect(screen.getByText('Sheet 1')).toBeVisible();
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: content.replace('35.00', '35.01') });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    expect(await screen.findByText('Sheet 1')).toBeVisible();
  });

  it('opens an encoded-only target with exact payload, paths, attributes, and capabilities', async () => {
    const payload = '\r\n  <script>opaque</script>\r\n  payload  \t';
    const content = fixture('encoded-aoi-v35').replace('\n  synthetic-aoi-payload', payload);
    const document = parseDocumentString(content, 'l5x').data!;
    expect(document.resources.some(resource => resource.kind === 'aoi' || resource.kind === 'routine')).toBe(false);
    await load(content);
    const region = within(screen.getByRole('region', { name: 'FixtureEncodedAOI payload' }));
    expect(region.getByRole('row', { name: 'EncryptionConfig 9' })).toBeVisible();
    expect(region.getByRole('row', { name: 'Decoded view false' })).toBeVisible();
    expect(region.getByRole('row', { name: 'Semantic queries false' })).toBeVisible();
    expect(region.getByRole('row', { name: `Source path ${document.encodedData[0].sourcePath}` })).toBeVisible();
    expect(editor().state.sliceDoc()).toBe(payload);
    expect(editor().state.readOnly).toBe(true);
    expect(screen.getByRole('textbox', { name: 'File content' })).toHaveAttribute('aria-readonly', 'true');
    expect(window.document.querySelector('script')).toBeNull();
  });

  it('keeps a named encoded tab on its payload after reorder, refresh and cached reopen', async () => {
    const encoded = (name: string, revision = '1', payload = name) => `<EncodedData EncodedType="AddOnInstructionDefinition" Name="${name}" Revision="${revision}"><![CDATA[payload ${payload}]]></EncodedData>`;
    const content = (inner: string) => wrap(`<AddOnInstructionDefinitions>${inner}</AddOnInstructionDefinitions>`);
    const view = await load(content(`${encoded('A')}${encoded('B')}`));
    openDocument();
    openRecord('A payload');
    await screen.findByRole('textbox', { name: 'File content' });
    expect(editor().state.sliceDoc()).toBe('payload A');
    const refreshed = content(`${encoded('B')}${encoded('A', '2', 'A refreshed')}`);
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: refreshed });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    expect(editor().state.sliceDoc()).toBe('payload A refreshed');
    expect(screen.getByRole('heading', { name: 'A payload' })).toBeVisible();
    const a = parseDocumentString(refreshed, 'l5x').data!.encodedData.find(value => value.attributes.Name === 'A')!;
    expect(screen.getByRole('row', { name: `Source path ${a.sourcePath}` })).toBeVisible();
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    await screen.findByRole('textbox', { name: 'File content' });
    expect(editor().state.sliceDoc()).toBe('payload A refreshed');
    openDocument();
    openRecord('A payload');
    expect(screen.getAllByRole('tab', { name: /A payload/ })).toHaveLength(1);
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: content(encoded('B')) });
    const handlers = vi.mocked(onEvent).mock.calls.filter(call => call[0] === 'files-changed');
    const reopenedHandler = handlers[handlers.length - 1][1];
    await act(async () => { reopenedHandler({ data: { path: filePath, eventType: 'write' } }); });
    expect(screen.getByText(/This source record is no longer available/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'File content' })).not.toBeInTheDocument();
  });

  it('keeps same-name encoded routines on their program owner after reordering', () => {
    const owner = (name: string) => `<Program Name="${name}" UId="${name === 'P1' ? '1' : '2'}"><Routines><EncodedData EncodedType="Routine" Name="Secret" Type="RLL"><![CDATA[payload ${name}]]></EncodedData></Routines></Program>`;
    const content = (inner: string) => wrap(`<Programs>${inner}</Programs>`);
    const before = buildDocumentRecords(parseDocumentString(content(`${owner('P1')}${owner('P2')}`), 'l5x').data!);
    const selection = before.find(record => record.encoded?.payload === 'payload P1')!.selection;
    const after = buildDocumentRecords(parseDocumentString(content(`${owner('P2')}${owner('P1')}`), 'l5x').data!);
    expect(findDocumentRecord(after, selection)?.encoded?.payload).toBe('payload P1');
  });

  it('refuses an encoded selection when another wrapper shares its owner, name and type', () => {
    const encoded = (payload: string) => `<EncodedData EncodedType="AddOnInstructionDefinition" Name="A"><![CDATA[${payload}]]></EncodedData>`;
    const content = (inner: string) => wrap(`<AddOnInstructionDefinitions>${inner}</AddOnInstructionDefinitions>`);
    const before = buildDocumentRecords(parseDocumentString(content(encoded('original')), 'l5x').data!);
    const selection = before.find(record => record.encoded)!.selection;
    const after = buildDocumentRecords(parseDocumentString(content(`${encoded('replacement')}${encoded('original')}`), 'l5x').data!);
    expect(findDocumentRecord(after, selection)).toBeUndefined();
  });

  it('keeps a preserved configuration on its program through reorder and cached reopen', async () => {
    const program = (name: string) => `<Program Name="${name}" UId="${name === 'P1' ? '1' : '2'}"><VendorConfiguration Owner="${name}"/></Program>`;
    const content = (inner: string) => wrap(`<Programs>${inner}</Programs>`);
    const original = content(`${program('P1')}${program('P2')}`);
    const selected = parseDocumentString(original, 'l5x').data!.fragments.find(fragment => fragment.path.includes('Program[1]/VendorConfiguration'))!;
    const view = await load(original);
    openDocument();
    const entry = overview().getByText(selected.path).closest('li')!;
    fireEvent.click(within(entry).getByRole('button', { name: 'VendorConfiguration[1]' }));
    await screen.findByRole('textbox', { name: 'File content' });
    expect(JSON.parse(editor().state.sliceDoc())).toEqual({ '@_Owner': 'P1' });
    const reordered = content(`${program('P2')}${program('P1')}`);
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: reordered });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    expect(JSON.parse(editor().state.sliceDoc())).toEqual({ '@_Owner': 'P1' });
    const refreshed = parseDocumentString(reordered, 'l5x').data!.fragments.find(fragment => fragment.path.includes('Program[2]/VendorConfiguration'))!;
    expect(screen.getByRole('row', { name: `Source path ${refreshed.path}` })).toBeVisible();
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    await screen.findByRole('textbox', { name: 'File content' });
    expect(JSON.parse(editor().state.sliceDoc())).toEqual({ '@_Owner': 'P1' });
  });

  it('tracks preserved siblings by their attributes when their source order changes', () => {
    const fragment = (id: string) => `<VendorConfiguration Index="${id}"><![CDATA[value ${id}]]></VendorConfiguration>`;
    const before = buildDocumentRecords(parseDocumentString(wrap(`${fragment('A')}${fragment('B')}`), 'l5x').data!);
    const selection = before.find(record => record.fragment?.path.endsWith('VendorConfiguration[1]'))!.selection;
    const after = buildDocumentRecords(parseDocumentString(wrap(`${fragment('B')}${fragment('A')}`), 'l5x').data!);
    expect(findDocumentRecord(after, selection)?.fragment?.value).toEqual({ '@_Index': 'A', '#cdata': 'value A' });
  });

  it('refuses a preserved selection when multiple sibling fragments have the same attributes', () => {
    const fragment = (text: string) => `<VendorConfiguration Index="A"><![CDATA[${text}]]></VendorConfiguration>`;
    const before = buildDocumentRecords(parseDocumentString(wrap(fragment('original')), 'l5x').data!);
    const selection = before.find(record => record.fragment?.path.endsWith('VendorConfiguration[1]'))!.selection;
    const after = buildDocumentRecords(parseDocumentString(wrap(`${fragment('replacement')}${fragment('original')}`), 'l5x').data!);
    expect(findDocumentRecord(after, selection)).toBeUndefined();
  });

  it('opens distinct trend templates and retains their owners through refresh and cached reopen', async () => {
    const trend = (name: string, template = `template ${name}`) => `<Trend Name="${name}"><Template>${template}</Template></Trend>`;
    const content = (inner: string) => wrap(`<Trends>${inner}</Trends>`);
    const original = content(`${trend('A')}${trend('B')}`);
    const view = await load(original);
    for (const name of ['A', 'B']) {
      openDocument();
      const fragment = parseDocumentString(original, 'l5x').data!.fragments.find(fragment => fragment.value === `template ${name}`)!;
      fireEvent.click(within(overview().getByText(fragment.path).closest('li')!).getByRole('button', { name: 'Template[1]' }));
      await screen.findByRole('textbox', { name: 'File content' });
      expect(JSON.parse(editor().state.sliceDoc())).toBe(`template ${name}`);
    }
    expect(screen.getAllByRole('tab', { name: /Template/ })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('tab', { name: /Template/ })[0]);
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: content(`${trend('B')}${trend('A', 'refreshed A')}`) });
    const handler = vi.mocked(onEvent).mock.calls.find(call => call[0] === 'files-changed')![1];
    await act(async () => { handler({ data: { path: filePath, eventType: 'write' } }); });
    expect(JSON.parse(editor().state.sliceDoc())).toBe('refreshed A');
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    await screen.findByRole('textbox', { name: 'File content' });
    expect(JSON.parse(editor().state.sliceDoc())).toBe('refreshed A');
    expect(screen.getAllByRole('tab', { name: /Template/ })).toHaveLength(2);
  });

  it('does not redirect a trend template selection when its named owner is replaced', () => {
    const trend = (name: string) => wrap(`<Trends><Trend Name="${name}"><Template>template ${name}</Template></Trend></Trends>`);
    const before = buildDocumentRecords(parseDocumentString(trend('A'), 'l5x').data!);
    const selection = before.find(record => record.fragment?.path.endsWith('/Template[1]'))!.selection;
    const after = buildDocumentRecords(parseDocumentString(trend('B'), 'l5x').data!);
    expect(findDocumentRecord(after, selection)).toBeUndefined();
  });

  it('invalidates templates under unnamed trend owners on refresh without losing current-document inspection', () => {
    const trend = (value: string) => `<Trend><Template>${value}</Template></Trend>`;
    const content = (inner: string) => wrap(`<Trends>${inner}</Trends>`);
    const document = parseDocumentString(content(`${trend('A')}${trend('B')}`), 'l5x').data!;
    const before = buildDocumentRecords(document);
    const selection = before.find(record => record.fragment?.value === 'A')!.selection;
    expect(findDocumentRecord(buildDocumentRecords(document), selection)?.fragment?.value).toBe('A');
    const after = buildDocumentRecords(parseDocumentString(content(trend('B')), 'l5x').data!);
    expect(findDocumentRecord(after, selection)).toBeUndefined();
  });

  it('inspects parsed preserved configuration and links covering diagnostics', async () => {
    const content = wrap('<VendorConfiguration Flag="yes"><![CDATA[<script>text</script>]]></VendorConfiguration>');
    await load(content);
    openDocument();
    fireEvent.click(overview().getByRole('button', { name: 'Preserved' }));
    openRecord('VendorConfiguration[1]');
    expect(screen.getByText(/Read-only parsed preserved representation/)).toBeVisible();
    expect(JSON.parse(editor().state.sliceDoc())).toEqual({ '#cdata': '<script>text</script>', '@_Flag': 'yes' });
    expect(document.querySelector('script')).toBeNull();

    const result = parseL5XDocument(content);
    const records = buildDocumentRecords(result.data!);
    const path = result.data!.fragments[0].path;
    const onOpen = vi.fn();
    result.warnings = [{ message: 'Preserved configuration', code: 'TEST', location: { path: `${path}/@Flag` } }];
    render(<L5XDocumentStatus result={result} records={records} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect source record' }));
    expect(onOpen).toHaveBeenCalledWith({ type: 'document', selection: records.find(record => record.fragment?.path === path)!.selection }, 'VendorConfiguration[1]');
    expect(findLocationRecord(records, '/absent')).toBeUndefined();
  });

  it('paginates preserved records without losing source order', async () => {
    await load(wrap(Array.from({ length: 61 }, (_, i) => `<VendorConfiguration Index="${i}"/>`).join('')));
    openDocument();
    fireEvent.click(overview().getByRole('button', { name: 'Preserved' }));
    expect(overview().getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(overview().getByRole('button', { name: 'Next records' }));
    openRecord('VendorConfiguration[61]');
    expect(JSON.parse(editor().state.sliceDoc())).toEqual({ '@_Index': '60' });
  });

  it('retains whole-file Raw after failed parsing and the existing text-read limit', async () => {
    const content = fixture('malformed-truncated-v35');
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content });
    const view = render(<L5XFileViewer filePath={filePath} />);
    await screen.findByText('Cannot parse L5X file');
    fireEvent.click(screen.getByRole('button', { name: 'View Raw' }));
    await screen.findByRole('textbox', { name: 'File content' });
    expect(editor().state.sliceDoc()).toBe(content);
    view.unmount();
    clearViewerCache();
    vi.mocked(ReadTextFile).mockResolvedValue({ success: false, error: 'File exceeds max 10MB' });
    render(<L5XFileViewer filePath={filePath} />);
    expect(await screen.findByText(/10 MB text viewer limit/)).toBeVisible();
  });
});
