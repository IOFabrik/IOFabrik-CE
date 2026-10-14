import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAllTabStates, getCachedTabState } from './l5x/useTabs';
import { clearViewerCache, getCachedContent } from '../../registry/viewer-cache';
import L5XViewer from './L5XViewer';
import L5XFileViewer from './L5XFileViewer';

const {
  readTextFileMock,
  controllerResultMock,
  onEventMock,
  registerAOIsFromControllerMock,
  clearAOIsMock,
  fbdDiagramMock,
  tagTableMock,
  testState,
} = vi.hoisted(() => ({
  readTextFileMock: vi.fn(),
  controllerResultMock: vi.fn(),
  onEventMock: vi.fn(),
  registerAOIsFromControllerMock: vi.fn(),
  clearAOIsMock: vi.fn(),
  fbdDiagramMock: vi.fn(),
  tagTableMock: vi.fn((_props: unknown) => <div>Tag Table</div>),
  testState: {
    theme: 'light' as 'light' | 'dark',
    themeListeners: new Set<() => void>(),
  },
}));

let filesChangedHandler: ((event: {
  data?: {
    path?: string;
    eventType?: string;
    isDir?: boolean;
  };
}) => void) | null = null;

vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({
  ReadTextFile: readTextFileMock,
}));

vi.mock('../../../context/LayoutContext', async () => {
  const React = await import('react');
  return {
    useLayout: () => ({
      theme: React.useSyncExternalStore(
        (listener) => {
          testState.themeListeners.add(listener);
          return () => testState.themeListeners.delete(listener);
        },
        () => testState.theme,
        () => testState.theme,
      ),
    }),
  };
});

vi.mock('../../../shared/runtime/events', () => ({
  onEvent: onEventMock,
}));

vi.mock('../shared/ViewerHeader', () => ({
  ViewerHeader: ({ filePath, extraContent }: { filePath: string; extraContent?: React.ReactNode }) => <div data-testid="viewer-header">{filePath}{extraContent}</div>,
}));

vi.mock('ladder-visualizer', () => {
  fbdDiagramMock.mockImplementation(({
    body,
    onDiagnostics,
    sheetIndex = 0,
    onSheetIndexChange,
  }: {
    body: { versionTag?: string };
    onDiagnostics?: (diagnostics: Array<{ code: string; message: string; severity: string }>) => void;
    sheetIndex?: number;
    onSheetIndexChange?: (sheetIndex: number) => void;
  }) => {
    return (
      <div data-testid="fbd-diagram">
        <div>{`FBD:${body.versionTag ?? 'unknown'}:sheet-${sheetIndex}`}</div>
        <button type="button" aria-label="Zoom in">Zoom in</button>
        <button type="button" aria-label="Zoom out">Zoom out</button>
        <button type="button" aria-label="Fit view">Fit view</button>
        <button type="button" onClick={() => onSheetIndexChange?.(sheetIndex + 1)}>
          Next FBD sheet
        </button>
        <button
          type="button"
          onClick={() => onDiagnostics?.([{
            code: 'FBD_PLACEHOLDER_ELEMENT',
            message: 'Unsupported element rendered as a placeholder.',
            severity: 'warning',
          }])}
        >
          Report FBD diagnostic
        </button>
      </div>
    );
  });

  return {
    parseDocumentString: (content: string, format: string) => {
      const result = controllerResultMock(content, format);
      return {
        ...result,
        data: result.data && {
          source: { format: 'l5x', targetType: 'Controller', targetName: result.data.name },
          resources: [{ kind: 'controller', id: '/Controller[1]', sourcePath: '/Controller[1]', role: 'target', data: result.data }],
          targetIds: ['/Controller[1]'], encodedData: [], fragments: [], mappings: [],
        },
      };
    },
    VirtualizedLadderDiagram: ({ routine }: { routine: { name: string; versionTag?: string } }) => (
      <div>{`RLL:${routine.name}@${routine.versionTag ?? 'unknown'}`}</div>
    ),
    FBDDiagram: fbdDiagramMock,
    ProgramNavigator: () => <div>Library comparison tree</div>,
    ControllerInfo: () => <div>Controller Info</div>,
    TagTable: tagTableMock,
    StructuredTextViewer: ({ routine }: { routine: { name: string; versionTag?: string } }) => (
      <div>{`ST:${routine.name}@${routine.versionTag ?? 'unknown'}`}</div>
    ),
    RawRoutineViewer: ({ routine }: { routine: { rawSource?: { text: string } } }) => (
      <pre>{routine.rawSource?.text ?? 'Original XML source is unavailable for this routine.'}</pre>
    ),
    AOIParameterTable: () => <div>AOI Parameters</div>,
    AOILocalTagTable: () => <div>AOI Local Tags</div>,
    ModuleInfoTable: () => <div>Module Info</div>,
    registerAOIsFromController: registerAOIsFromControllerMock,
    clearAOIs: clearAOIsMock,
    DARK_THEME: { name: 'dark-theme' },
  };
});

function makeFBDBody(versionTag: string) {
  return {
    versionTag,
    sheetSize: { value: 'D', source: 'declared' },
    orientation: { value: 'Landscape', source: 'declared' },
    sheets: [
      {
        number: { value: '1', source: 'declared' },
        name: { value: 'Sheet 1', source: 'declared' },
        descriptions: [],
        elements: [],
        connections: [],
        attachments: [],
      },
      {
        number: { value: '2', source: 'declared' },
        name: { value: 'Sheet 2', source: 'declared' },
        descriptions: [],
        elements: [],
        connections: [],
        attachments: [],
      },
    ],
    diagnostics: [],
  };
}

function makeRoutine(name: string, type: 'RLL' | 'FBD' | 'ST' | 'SFC', versionTag: string) {
  return {
    name,
    type,
    versionTag,
    rungs: [],
    ...(type === 'FBD' ? { fbd: makeFBDBody(versionTag) } : {}),
  };
}

function makeController(
  versionTag: string,
  options?: {
    includeRoutine?: boolean;
    routineType?: 'RLL' | 'FBD' | 'ST' | 'SFC';
    includeAOIFBD?: boolean;
    includeDataTypes?: boolean;
  },
) {
  const includeRoutine = options?.includeRoutine ?? true;
  const routineType = options?.routineType ?? 'RLL';

  return {
    name: `Controller ${versionTag}`,
    programs: [
      {
        name: 'MainProgram',
        tags: [] as Array<{ name: string; dataType: string }>,
        routines: includeRoutine
          ? [makeRoutine('RoutineA', routineType, versionTag)]
          : [],
      },
    ],
    tags: [] as Array<{ name: string; dataType: string }>,
    dataTypes: [],
    dataTypeCatalog: options?.includeDataTypes
      ? [
          {
            name: 'PumpState',
            class: 'User',
            category: 'UserDefined',
            resolution: 'Declared',
            description: 'Current pump operating state.',
            members: [{
              name: 'Mode',
              dataType: 'DINT',
              dimension: 0,
              dimensions: [],
              description: 'State code.',
            }],
          },
          {
            name: 'DINT',
            class: 'BuiltIn',
            category: 'Predefined',
            resolution: 'Atomic',
            members: [],
          },
        ]
      : [],
    aois: options?.includeAOIFBD
      ? [{
          name: 'MixerAOI',
          parameters: [],
          localTags: [],
          routines: [makeRoutine('Logic', 'FBD', `AOI-${versionTag}`)],
        }]
      : [],
    modules: [],
  };
}

function queueSuccessfulRead(contents: string[]) {
  readTextFileMock.mockReset();
  contents.forEach((content) => {
    readTextFileMock.mockResolvedValueOnce({
      success: true,
      content,
    });
  });
}

async function emitFilesChanged(path: string, eventType: string, isDir = false) {
  if (!filesChangedHandler) {
    throw new Error('files-changed handler has not been registered');
  }

  await act(async () => {
    filesChangedHandler?.({
      data: {
        path,
        eventType,
        isDir,
      },
    });
  });
}

async function renderLoadedViewer(filePath = '/repo/Programs/Main.L5X') {
  render(<L5XViewer filePath={filePath} />);
  await screen.findByText('No Content Selected');
}

function organizer() {
  const navigators = screen.getAllByRole('navigation', { name: 'Project entries' });
  return within(navigators[navigators.length - 1]);
}

function mainTabs() {
  return within(screen.getByRole('tablist', { name: 'L5X views' }));
}

function dataTypeView(name: string) {
  return within(screen.getByRole('tablist', { name: `${name} views` }).parentElement!);
}

function metadataView(owner: string) {
  return within(screen.getByRole('region', { name: `${owner} Metadata` }));
}

function declarationView(title: string) {
  return within(screen.getByRole('heading', { name: title }).parentElement!);
}

function clickEntry(label: string) {
  fireEvent.click(organizer().getByRole('button', { name: label }));
}

function expandEntry(label: string) {
  const arrow = organizer().queryByRole('button', { name: `Expand ${label}` });
  if (arrow) fireEvent.click(arrow);
}

function openProgramRoutine(program = 'MainProgram') {
  expandEntry(program);
  clickEntry('RoutineA');
}

function latestFBDDiagramProps() {
  const calls = fbdDiagramMock.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe('L5XViewer refresh behavior', () => {
  beforeEach(() => {
    filesChangedHandler = null;
    testState.theme = 'light';
    testState.themeListeners.clear();
    clearViewerCache();
    clearAllTabStates();
    vi.clearAllMocks();

    onEventMock.mockImplementation((eventName: string, handler: typeof filesChangedHandler) => {
      if (eventName === 'files-changed') {
        filesChangedHandler = handler;
      }
      return vi.fn();
    });

    controllerResultMock.mockImplementation((content: string) => ({
      success: true,
      data: makeController(content),
      errors: [],
    }));
  });

  function metadataController(version: string) {
    const base = makeController(version, { includeDataTypes: true, includeAOIFBD: true });
    return { ...base,
      programs: [{ ...base.programs[0], uid: '18446744073709551615', description: `Description ${version}`,
        mainRoutineName: 'RoutineA', executingTaskName: 'Cycle', parameters: [], localTags: [] }],
      tasks: [{ name: 'Cycle', type: 'Periodic', rate: 0, scheduledProgramNames: ['MainProgram'] }],
      modules: [{ name: 'Rack', id: 0, ports: [], connections: [], inhibited: false, majorFault: false, safetyEnabled: false }],
    };
  }

  function declarationController(version: string) {
    const base = metadataController(version);
    return { ...base,
      programs: [{ ...base.programs[0], tags: [{ name: 'Shared', dataType: 'DINT' }],
        localTags: [{ name: 'Shared', dataType: 'DINT', scope: 'Program', programName: 'MainProgram',
          description: `Program local ${version}`, comments: [], defaultValue: 0 }],
        parameters: [{ name: 'Shared', dataType: 'DINT', scope: 'Program', programName: 'MainProgram',
          usage: 'Input', description: `Program parameter ${version}`, comments: [] }] }],
      aois: [{ ...base.aois[0], localTags: [{ name: 'Shared', dataType: 'DINT', description: 'AOI local', externalAccess: 'None' }],
        parameters: [{ name: 'Shared', dataType: 'DINT', usage: 'InOut', description: 'AOI parameter', required: false, visible: false }] }],
    };
  }

  it('keeps ordinary tags, program locals, program parameters and AOI declarations in distinct tabs', async () => {
    const data = declarationController('v1');
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data });
    await renderLoadedViewer();
    clickEntry('MainProgram');
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: 'Open Program tags: 1' }));
    expect(tagTableMock.mock.calls[tagTableMock.mock.calls.length - 1]?.[0]).toMatchObject({ tags: data.programs[0].tags });
    for (const [owner, label, title, description] of [
      ['MainProgram', 'Local tags', 'MainProgram Local Tags', 'Program local v1'],
      ['MainProgram', 'Parameters', 'MainProgram Parameters', 'Program parameter v1'],
      ['MixerAOI', 'Local tags', 'MixerAOI Local Tags', 'AOI local'],
      ['MixerAOI', 'Parameters', 'MixerAOI Parameters', 'AOI parameter'],
    ]) {
      clickEntry(owner);
      fireEvent.click(metadataView(owner).getByRole('button', { name: `Open ${label}: 1` }));
      const declaration = declarationView(title).getByRole('button', { name: /1\. Shared DINT/ });
      fireEvent.click(declaration);
      expect(within(declaration.parentElement!).getByRole('row', { name: `Description ${description}` })).toBeVisible();
      expect(mainTabs().getByRole('tab', { name: new RegExp(title) })).toHaveAttribute('aria-selected', 'true');
    }
    const tabCount = mainTabs().getAllByRole('tab').length;
    clickEntry('MainProgram');
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: 'Open Local tags: 1' }));
    expect(mainTabs().getAllByRole('tab')).toHaveLength(tabCount);
    expect(declarationView('MainProgram Local Tags').getByRole('row', { name: 'Description Program local v1' })).toBeVisible();
  }, 15000);

  it.each(['Local tags', 'Parameters'])('retains %s ownership and cached tabs across rename, reorder and removal', async label => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = declarationController(version);
      if (version !== 'v1') {
        data.programs[0].name = 'Renamed';
        data.programs[0].localTags[0].programName = 'Renamed';
        data.programs[0].parameters[0].programName = 'Renamed';
        data.programs.unshift({ ...data.programs[0], name: 'Other', uid: '2', localTags: [], parameters: [] });
      }
      if (version === 'v3') data.programs.pop();
      return { success: true, data };
    });
    const path = '/repo/declarations.L5X';
    const mounted = render(<L5XViewer filePath={path} />);
    await screen.findByText('No Content Selected');
    clickEntry('MainProgram');
    const title = label === 'Local tags' ? 'Local Tags' : label;
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: `Open ${label}: 1` }));
    fireEvent.click(declarationView(`MainProgram ${title}`).getByRole('button', { name: /1\. Shared DINT/ }));
    await emitFilesChanged(path, 'write');
    expect(await screen.findByRole('heading', { name: `Renamed ${title}` })).toBeVisible();
    const declaration = declarationView(`Renamed ${title}`).getByRole('button', { name: /1\. Shared DINT/ });
    fireEvent.click(declaration);
    expect(within(declaration.parentElement!).getByRole('row', { name: 'Program Renamed' })).toBeVisible();
    mounted.unmount();
    render(<L5XViewer filePath={path} />);
    expect(await screen.findByRole('heading', { name: `Renamed ${title}` })).toBeVisible();
    expect(readTextFileMock).toHaveBeenCalledTimes(2);
    const count = mainTabs().getAllByRole('tab').length;
    clickEntry('Renamed');
    fireEvent.click(metadataView('Renamed').getByRole('button', { name: `Open ${label}: 1` }));
    expect(mainTabs().getAllByRole('tab')).toHaveLength(count);
    await emitFilesChanged(path, 'write');
    expect(await screen.findByText(/This owner is missing or ambiguous/)).toBeVisible();
  });

  it.each(['Local tags', 'Parameters'])('does not redirect %s to another program after a duplicate UID disappears', async label => {
    queueSuccessfulRead(['v1', 'v2']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = declarationController(version);
      data.programs.push({ ...data.programs[0], name: 'Collision' });
      if (version === 'v2') data.programs.shift();
      return { success: true, data };
    });
    await renderLoadedViewer();
    clickEntry('MainProgram');
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: `Open ${label}: 1` }));
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText(/This owner is missing or ambiguous/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /1\. Shared DINT/ })).not.toBeInTheDocument();
  });

  it('opens trends and watch lists from both organizer entries and metadata links, including empty collections', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: declarationController('v1') });
    await renderLoadedViewer();
    for (const [entry, link] of [['Trends', 'Trends'], ['Quick Watch Lists', 'Quick-watch lists']]) {
      clickEntry(entry);
      expect(within(screen.getByRole('heading', { name: `Controller v1 ${entry}` }).parentElement!).getByText(/No entries in this collection/)).toBeVisible();
      clickEntry('Controller Controller v1');
      const count = mainTabs().getAllByRole('tab').length;
      fireEvent.click(metadataView('Controller v1').getByRole('button', { name: `Open ${link}: 0` }));
      expect(mainTabs().getAllByRole('tab')).toHaveLength(count);
    }
  });

  it('opens six entity families from the organizer, defaulting datatypes to table without duplicate tabs', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    await renderLoadedViewer();
    expandEntry('User Defined');
    const labels = ['Controller Controller v1', 'MainProgram', 'Cycle', 'MixerAOI', 'PumpState', 'Rack'];
    for (const label of labels) {
      clickEntry(label);
      expect(organizer().getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
      if (label === 'PumpState') expect(dataTypeView(label).getByRole('tab', { name: 'table' })).toHaveAttribute('aria-selected', 'true');
      else expect(screen.getAllByRole('heading', { level: 2 }).some(heading => heading.textContent?.includes('Metadata'))).toBe(true);
    }
    expect(screen.queryByText('Metadata', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Controller Info')).not.toBeInTheDocument();
    expect(screen.queryByText('Module Info')).not.toBeInTheDocument();
    expect(mainTabs().getAllByRole('tab')).toHaveLength(6);
    clickEntry('MainProgram');
    expect(mainTabs().getAllByRole('tab')).toHaveLength(6);
    const taskTab = mainTabs().getByRole('tab', { name: /Cycle Metadata/ });
    taskTab.focus();
    fireEvent.keyDown(taskTab, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'Cycle Metadata' })).toBeVisible();
  });

  it('keeps metadata, routine links and selection attached to their owner after reordering and removal', async () => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      if (version !== 'v1') {
        data.programs.unshift({ ...data.programs[0], uid: '1', name: 'Other',
          routines: [makeRoutine('OtherRoutine', 'RLL', version)] });
        if (version === 'v3') data.programs.pop();
      }
      return { success: true, data };
    });
    await renderLoadedViewer();
    expandEntry('MainProgram');
    clickEntry('MainProgram');
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    expect(screen.getByText('RLL:RoutineA@v1')).toBeVisible();
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('RLL:RoutineA@v2')).toBeVisible();
    expandEntry('MainProgram');
    expect(organizer().getByRole('button', { name: 'RoutineA' })).toHaveAttribute('aria-pressed', 'true');
    clickEntry('MainProgram');
    expect(screen.getByText('Description v2')).toBeVisible();
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    expect(mainTabs().getAllByRole('tab')).toHaveLength(2);
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('Routine not found')).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /MainProgram Metadata/ }));
    expect(screen.getByText(/This entity is no longer in the file/)).toBeVisible();
  });

  it('opens existing AOI, datatype and module views from metadata links', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    await renderLoadedViewer();
    clickEntry('MixerAOI');
    fireEvent.click(metadataView('MixerAOI').getByRole('button', { name: 'Open Parameters: 0' }));
    expect(screen.getByRole('heading', { name: 'MixerAOI Parameters' })).toBeVisible();
    expect(mainTabs().getByRole('tab', { name: /MixerAOI Parameters/ })).toBeVisible();
    expandEntry('User Defined');
    clickEntry('PumpState');
    fireEvent.click(dataTypeView('PumpState').getByRole('tab', { name: 'other' }));
    fireEvent.click(dataTypeView('PumpState').getByRole('button', { name: 'Open Member structure: 1' }));
    expect(screen.getByRole('heading', { name: 'PumpState' })).toBeVisible();
    clickEntry('Rack');
    fireEvent.click(metadataView('Rack').getByRole('button', { name: 'Open Module configuration: Rack' }));
    expect(screen.getByText('Module Info')).toBeVisible();
  });

  it('retains program-tag ownership and deduplication after UID-preserving rename and name reuse', async () => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      data.programs[0].tags = [{ name: 'OriginalTag', dataType: 'BOOL' }];
      if (version !== 'v1') {
        data.programs[0].name = 'Renamed';
        data.programs.unshift({ ...data.programs[0], name: 'MainProgram', uid: '1',
          tags: [{ name: 'ReplacementTag', dataType: 'BOOL' }] });
      }
      if (version === 'v3') data.programs.pop();
      return { success: true, data };
    });
    await renderLoadedViewer();
    clickEntry('MainProgram');
    fireEvent.click(metadataView('MainProgram').getByRole('button', { name: 'Open Program tags: 1' }));
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'OriginalTag', dataType: 'BOOL' }] }), expect.anything());
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Renamed' })).toBeInTheDocument());
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'OriginalTag', dataType: 'BOOL' }] }), expect.anything());
    clickEntry('Renamed');
    expect(mainTabs().getByRole('tab', { name: /Renamed Metadata/ })).toBeVisible();
    fireEvent.click(metadataView('Renamed').getByRole('button', { name: 'Open Program tags: 1' }));
    expect(mainTabs().getByRole('tab', { name: /Renamed Tags/ })).toBeVisible();
    expect(mainTabs().getAllByRole('tab')).toHaveLength(2);
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText(/This program is no longer in the file/)).toBeVisible();
    expect(screen.queryByText('No program-specific tags defined')).not.toBeInTheDocument();
  });

  it('keeps duplicate-UID inspectors and linked views on the selected program through reorder and removal', async () => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      const programs = ['DuplicateA', 'DuplicateB'].map(name => ({ ...data.programs[0], name, uid: '10',
        tags: [{ name: `${name}Tag`, dataType: 'BOOL' }], routines: [makeRoutine('RoutineA', 'RLL', `${name}-${version}`)] }));
      data.programs = version === 'v1' ? programs.reverse() : version === 'v3' ? programs.slice(0, 1) : programs;
      return { success: true, status: 'partial', data };
    });
    await renderLoadedViewer();
    expandEntry('DuplicateB');
    clickEntry('Program Tags');
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'DuplicateBTag', dataType: 'BOOL' }] }), expect.anything());
    openProgramRoutine('DuplicateB');
    expect(screen.getByText('RLL:RoutineA@DuplicateB-v1')).toBeVisible();
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('RLL:RoutineA@DuplicateB-v2')).toBeVisible();
    expandEntry('DuplicateB');
    expect(organizer().getByRole('button', { name: 'RoutineA' })).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['DuplicateA', 'DuplicateB']) {
      clickEntry(name);
      expect(screen.getByRole('heading', { name: `${name} Metadata` })).toBeVisible();
      fireEvent.click(metadataView(name).getByRole('button', { name: 'Open Main routine: RoutineA' }));
      expect(screen.getByText(`RLL:RoutineA@${name}-v2`)).toBeVisible();
    }
    expect(mainTabs().getAllByRole('tab', { name: /RoutineA/ })).toHaveLength(2);
    clickEntry('DuplicateB');
    fireEvent.click(metadataView('DuplicateB').getByRole('button', { name: 'Open Program tags: 1' }));
    expect(mainTabs().getAllByRole('tab')).toHaveLength(5);
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'DuplicateBTag', dataType: 'BOOL' }] }), expect.anything());
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText(/This program is no longer in the file/)).toBeVisible();
    fireEvent.click(mainTabs().getAllByRole('tab', { name: /RoutineA/ })[0]);
    expect(screen.getByText('Routine not found')).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /DuplicateB Metadata/ }));
    expect(screen.getByText(/This entity is no longer in the file/)).toBeVisible();
  });

  it('never redirects a previously unique UID after it collides and the original program disappears', async () => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      const original = { ...data.programs[0], name: 'Original', uid: '10',
        tags: [{ name: 'OriginalTag', dataType: 'BOOL' }] };
      const replacement = { ...original, name: 'Replacement', tags: [{ name: 'ReplacementTag', dataType: 'BOOL' }] };
      data.programs = version === 'v1' ? [original] : version === 'v2' ? [replacement, original] : [replacement];
      return { success: true, data };
    });
    await renderLoadedViewer();
    clickEntry('Original');
    fireEvent.click(metadataView('Original').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    clickEntry('Original');
    fireEvent.click(metadataView('Original').getByRole('button', { name: 'Open Program tags: 1' }));
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await screen.findByRole('button', { name: 'Replacement' });
    clickEntry('Original');
    expect(mainTabs().getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Original Metadata' })).toBeVisible();
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText(/This entity is no longer in the file/)).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /RoutineA/ }));
    expect(screen.getByText('Routine not found')).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /Original Tags/ }));
    expect(screen.getByText(/This program is no longer in the file/)).toBeVisible();
  });

  it.each([false, true])('retains an observed unique rename before a later UID collision, cached remount: %s', async remount => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      const original = { ...data.programs[0], name: version === 'v1' ? 'Original' : 'Renamed', uid: '10',
        description: 'Owned metadata', tags: [{ name: 'OwnedTag', dataType: 'BOOL' }],
        routines: [makeRoutine('RoutineA', 'RLL', `owned-${version}`)] };
      data.programs = version === 'v3' ? [{ ...original, name: 'Original', description: 'Replacement metadata',
        tags: [{ name: 'ReplacementTag', dataType: 'BOOL' }], routines: [makeRoutine('RoutineA', 'RLL', 'replacement')] }, original] : [original];
      return { success: true, data };
    });
    const view = render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('No Content Selected');
    clickEntry('Original');
    fireEvent.click(metadataView('Original').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    clickEntry('Original');
    fireEvent.click(metadataView('Original').getByRole('button', { name: 'Open Program tags: 1' }));
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await screen.findByRole('button', { name: 'Renamed' });
    expect(mainTabs().getByRole('tab', { name: /Renamed Metadata/ })).toBeVisible();
    if (remount) {
      view.unmount();
      render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
      await screen.findByRole('button', { name: 'Renamed' });
    }
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await screen.findByRole('button', { name: 'Original' });
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'OwnedTag', dataType: 'BOOL' }] }), expect.anything());
    fireEvent.click(mainTabs().getByRole('tab', { name: /RoutineA/ }));
    expect(screen.getByText('RLL:RoutineA@owned-v3')).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /Renamed Metadata/ }));
    expect(screen.getByText('Owned metadata')).toBeVisible();
    expect(organizer().getByRole('button', { name: 'Renamed' })).toHaveAttribute('aria-pressed', 'true');
    clickEntry('Renamed');
    fireEvent.click(metadataView('Renamed').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    expect(mainTabs().getAllByRole('tab')).toHaveLength(3);
  });

  it('retains the source UID when reopened ambiguous views outlive their program and its name is reused', async () => {
    queueSuccessfulRead(['v1', 'v2', 'v3']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      const original = { ...data.programs[0], name: 'Original', uid: version === 'v3' ? '20' : '10',
        tags: [{ name: version === 'v3' ? 'ReplacementTag' : 'OriginalTag', dataType: 'BOOL' }],
        routines: [makeRoutine('RoutineA', 'RLL', version)] };
      data.programs = version === 'v1' ? [original] : [original, { ...original, name: 'Duplicate', uid: '10' }];
      return { success: true, data };
    });
    await renderLoadedViewer();
    const openOriginalViews = () => {
      clickEntry('Original');
      fireEvent.click(metadataView('Original').getByRole('button', { name: 'Open Main routine: RoutineA' }));
      clickEntry('Original');
      fireEvent.click(metadataView('Original').getByRole('button', { name: 'Open Program tags: 1' }));
    };
    openOriginalViews();
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await screen.findByRole('button', { name: 'Duplicate' });
    openOriginalViews();
    expect(mainTabs().getAllByRole('tab')).toHaveLength(3);
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText(/This program is no longer in the file/)).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /RoutineA/ }));
    expect(screen.getByText('Routine not found')).toBeVisible();
    fireEvent.click(mainTabs().getByRole('tab', { name: /Original Metadata/ }));
    expect(screen.getByText(/This entity is no longer in the file/)).toBeVisible();
    openOriginalViews();
    expect(mainTabs().getAllByRole('tab')).toHaveLength(6);
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'ReplacementTag', dataType: 'BOOL' }] }), expect.anything());
  });

  it('deduplicates surviving duplicate-UID views after refresh and a cached viewer remount', async () => {
    queueSuccessfulRead(['v1', 'v2']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      data.programs = ['DuplicateB', ...(version === 'v1' ? ['DuplicateA'] : [])]
        .map(name => ({ ...data.programs[0], name, uid: '10', tags: [{ name: `${name}Tag`, dataType: 'BOOL' }] }));
      return { success: true, data };
    });
    const view = render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('No Content Selected');
    clickEntry('DuplicateB');
    fireEvent.click(metadataView('DuplicateB').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    clickEntry('DuplicateB');
    fireEvent.click(metadataView('DuplicateB').getByRole('button', { name: 'Open Program tags: 1' }));
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await screen.findByRole('button', { name: 'DuplicateB' });
    view.unmount();
    render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByRole('button', { name: 'DuplicateB' });
    clickEntry('DuplicateB');
    fireEvent.click(metadataView('DuplicateB').getByRole('button', { name: 'Open Main routine: RoutineA' }));
    clickEntry('DuplicateB');
    fireEvent.click(metadataView('DuplicateB').getByRole('button', { name: 'Open Program tags: 1' }));
    expect(mainTabs().getAllByRole('tab')).toHaveLength(3);
    expect(tagTableMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: [{ name: 'DuplicateBTag', dataType: 'BOOL' }] }), expect.anything());
  });

  it.each(['Enter', ' '])('does not cancel native close-button activation with %s', async key => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    await renderLoadedViewer();
    clickEntry('MainProgram');
    const tab = mainTabs().getByRole('tab', { name: /MainProgram Metadata/ });
    const close = within(tab).getByRole('button', { name: 'Close tab' });
    close.focus();
    expect(fireEvent.keyDown(close, { key })).toBe(true);
    fireEvent.click(close);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('virtualizes a large organizer and finds an entry beyond the viewport', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(280);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256);
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    const data = metadataController('v1');
    data.tasks = Array.from({ length: 70 }, (_, index) => ({ name: `Task${index}`, type: 'Periodic', rate: index, scheduledProgramNames: [] }));
    controllerResultMock.mockReturnValue({ success: true, data });
    await renderLoadedViewer();
    const nav = screen.getByRole('navigation', { name: 'Project entries' });
    expect(within(nav).getAllByRole('button').length).toBeLessThan(50);
    fireEvent.change(screen.getByRole('textbox', { name: 'Find organizer entry' }), { target: { value: 'Task69' } });
    clickEntry('Task69');
    expect(screen.getByRole('heading', { name: 'Task69 Metadata' })).toBeVisible();
    height.mockRestore();
    width.mockRestore();
  });

  it('opens metadata from labels while arrows and group labels only change expansion', async () => {
    queueSuccessfulRead(['v1']);
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    await renderLoadedViewer();
    clickEntry('MainProgram');
    expect(screen.getByRole('heading', { name: 'MainProgram Metadata' })).toBeVisible();
    expect(organizer().queryByRole('button', { name: 'Program Tags' })).not.toBeInTheDocument();
    expandEntry('MainProgram');
    expect(mainTabs().getAllByRole('tab')).toHaveLength(1);
    clickEntry('Program Tags');
    expect(screen.getByText('No program-specific tags defined')).toBeVisible();
    fireEvent.click(organizer().getByRole('button', { name: 'Collapse MainProgram' }));
    expect(mainTabs().getByRole('tab', { name: /MainProgram Tags/ })).toHaveAttribute('aria-selected', 'true');
    clickEntry('Tasks');
    expect(organizer().queryByRole('button', { name: 'MainProgram' })).not.toBeInTheDocument();
    expect(mainTabs().getAllByRole('tab')).toHaveLength(2);
    clickEntry('Tasks');
    expect(organizer().getByRole('button', { name: 'MainProgram' })).toBeVisible();
  });

  it('switches to raw text without mixing parsed caches and preserves structured selection', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: '<Controller />' });
    const view = render(<L5XFileViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByRole('button', { name: 'MainProgram' });
    openProgramRoutine();
    expect(await screen.findByText('RLL:RoutineA@<Controller />')).toBeVisible();
    expect(screen.getAllByTestId('viewer-header')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(await screen.findByText('<Controller />')).toBeVisible();
    expect(screen.getByText('RLL:RoutineA@<Controller />')).not.toBeVisible();
    expect(getCachedContent('/repo/Programs/Main.L5X')).toBe('<Controller />');
    expect(getCachedContent('l5x:/repo/Programs/Main.L5X')).toMatchObject({ controller: { name: 'Controller <Controller />' } });

    fireEvent.click(screen.getByRole('button', { name: 'Pretty' }));
    expect(screen.getByText('RLL:RoutineA@<Controller />')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    view.unmount();
    render(<L5XFileViewer filePath="/repo/Programs/Main.L5X" />);
    expect(screen.getByRole('button', { name: 'Pretty' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers source inspection after parsing fails and refreshes raw text', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: '<broken>' });
    controllerResultMock.mockReturnValue({ success: false, errors: [{ message: 'Invalid XML' }] });
    render(<L5XFileViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('Cannot parse L5X file');
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(await screen.findByText('<broken>')).toBeVisible();
    readTextFileMock.mockResolvedValue({ success: true, content: '<updated>' });
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('<updated>')).toBeVisible();
  });

  it('reads and parses the file once on initial render', async () => {
    queueSuccessfulRead(['v1']);

    await renderLoadedViewer();

    expect(readTextFileMock).toHaveBeenCalledTimes(1);
    expect(readTextFileMock).toHaveBeenCalledWith('/repo/Programs/Main.L5X');
    expect(controllerResultMock).toHaveBeenCalledTimes(1);
    expect(getCachedContent('l5x:/repo/Programs/Main.L5X')).toMatchObject({
      controller: { name: 'Controller v1' },
    });
  });

  it('keeps partial content usable and shows source locations with a working Raw action', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'partial source' });
    controllerResultMock.mockReturnValue({ success: true, status: 'partial', data: makeController('partial'),
      warnings: [{ message: 'Unsupported declaration dimensions.', location: { line: 12, column: 4, path: '/Controller[1]/Tags[1]' } }] });
    render(<L5XFileViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('Some content needs source inspection');
    openProgramRoutine();
    expect(await screen.findByText('RLL:RoutineA@partial')).toBeVisible();
    fireEvent.click(screen.getByText('1 parser notice'));
    expect(screen.getByText('Line 12, column 4, /Controller[1]/Tags[1]')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'View Raw' }));
    expect(await screen.findByText('partial source')).toBeVisible();
    expect(getCachedContent('l5x:/repo/Programs/Main.L5X')).toMatchObject({ status: 'partial', warnings: [{ location: { line: 12 } }] });
  });

  it.each(['success', 'error'])('ignores a stale %s from an earlier reload of the same file', async outcome => {
    queueSuccessfulRead(['v1']);
    await renderLoadedViewer();
    openProgramRoutine();
    let resolveRead!: (result: { success: boolean; content: string }) => void;
    let rejectRead!: (error: Error) => void;
    readTextFileMock.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }))
      .mockResolvedValueOnce({ success: true, content: 'v3' });
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    await waitFor(() => expect(readTextFileMock).toHaveBeenCalledTimes(2));
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('RLL:RoutineA@v3')).toBeVisible();
    await act(async () => {
      if (outcome === 'success') resolveRead({ success: true, content: 'v2' });
      else rejectRead(new Error('stale read failure'));
    });
    expect(screen.getByText('RLL:RoutineA@v3')).toBeVisible();
    expect(getCachedContent('l5x:/repo/Programs/Main.L5X')).toMatchObject({ controller: { name: 'Controller v3' } });
    expect(screen.queryByText('stale read failure')).not.toBeInTheDocument();
  });

  it('ignores files-changed events for other files', async () => {
    queueSuccessfulRead(['v1']);

    await renderLoadedViewer();
    await emitFilesChanged('/repo/Programs/Other.L5X', 'write');

    await waitFor(() => {
      expect(readTextFileMock).toHaveBeenCalledTimes(1);
      expect(controllerResultMock).toHaveBeenCalledTimes(1);
    });
  });

  it('reloads after a matching write event and replaces the cached controller', async () => {
    queueSuccessfulRead(['v1', 'v2']);

    await renderLoadedViewer();
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');

    await waitFor(() => {
      expect(readTextFileMock).toHaveBeenCalledTimes(2);
      expect(controllerResultMock).toHaveBeenCalledTimes(2);
      expect(getCachedContent('l5x:/repo/Programs/Main.L5X')).toMatchObject({
        controller: { name: 'Controller v2' },
      });
    });
  });

  it.each(['rename', 'remove'])('reloads after a matching %s event', async (eventType) => {
    queueSuccessfulRead(['v1', 'v2']);

    await renderLoadedViewer();
    await emitFilesChanged('/repo/Programs/Main.L5X', eventType);

    await waitFor(() => {
      expect(readTextFileMock).toHaveBeenCalledTimes(2);
      expect(controllerResultMock).toHaveBeenCalledTimes(2);
    });
  });

  it('preserves the selected routine across reload when the routine still exists', async () => {
    queueSuccessfulRead(['v1', 'v2']);

    await renderLoadedViewer();

    openProgramRoutine();
    expect(await screen.findByText('RLL:RoutineA@v1')).toBeInTheDocument();
    expect(organizer().getByRole('button', { name: 'RoutineA' })).toHaveAttribute('aria-pressed', 'true');

    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');

    expect(await screen.findByText('RLL:RoutineA@v2')).toBeInTheDocument();
    expandEntry('MainProgram');
    expect(organizer().getByRole('button', { name: 'RoutineA' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens catalog data types and follows nested type selections in tabs', async () => {
    queueSuccessfulRead(['v1']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('v1', { includeDataTypes: true }),
      errors: [],
    }));

    await renderLoadedViewer();
    expandEntry('User Defined');
    clickEntry('PumpState');
    expect(await screen.findByRole('heading', { name: 'PumpState' })).toBeInTheDocument();
    expect(screen.getAllByText('Current pump operating state.')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Open DINT' }));
    expect(await screen.findByRole('heading', { name: 'DINT' })).toBeInTheDocument();
    expect(screen.getByText('This is an atomic data type with no member structure.')).toBeInTheDocument();
  });

  it('restores the main-branch member table and switches to complete metadata within one datatype tab', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    await renderLoadedViewer();
    expandEntry('User Defined');
    clickEntry('PumpState');
    const view = dataTypeView('PumpState');
    expect(mainTabs().getAllByRole('tab')).toHaveLength(1);
    expect(mainTabs().getByRole('tab', { name: /PumpState/ })).toHaveAttribute('title', 'PumpState');
    expect(view.getByRole('tab', { name: 'table' })).toHaveAttribute('aria-selected', 'true');
    expect(view.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Name', 'Data Type', 'Description']);
    expect(view.getByRole('row', { name: 'Mode DINT State code.' })).toBeInTheDocument();
    fireEvent.click(view.getByRole('tab', { name: 'other' }));
    expect(view.getByRole('heading', { name: 'PumpState Metadata' })).toBeVisible();
    expect(view.getByRole('row', { name: 'Category UserDefined' })).toBeVisible();
    expect(view.getByRole('row', { name: 'Dimensions Scalar' })).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: 'Open Member structure: 1' }));
    expect(view.getByRole('tab', { name: 'table' })).toHaveAttribute('aria-selected', 'true');
    expect(mainTabs().getAllByRole('tab')).toHaveLength(1);
  });

  it('retains datatype view selection through navigation, refresh and cached remount, then resets after closing', async () => {
    queueSuccessfulRead(['v1', 'v2']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      data.dataTypeCatalog[0].description = `Description ${version}`;
      return { success: true, data };
    });
    const viewer = render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('No Content Selected');
    expandEntry('User Defined');
    clickEntry('PumpState');
    fireEvent.click(dataTypeView('PumpState').getByRole('tab', { name: 'other' }));
    clickEntry('Controller Controller v1');
    clickEntry('PumpState');
    expect(dataTypeView('PumpState').getByRole('tab', { name: 'other' })).toHaveAttribute('aria-selected', 'true');
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await dataTypeView('PumpState').findByRole('row', { name: 'Description Description v2' })).toBeVisible();
    expect(dataTypeView('PumpState').getByRole('tab', { name: 'other' })).toHaveAttribute('aria-selected', 'true');
    viewer.unmount();
    render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByRole('tablist', { name: 'PumpState views' });
    expect(dataTypeView('PumpState').getByRole('tab', { name: 'other' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(mainTabs().getByRole('tab', { name: /PumpState/ })).getByRole('button', { name: 'Close tab' }));
    expandEntry('User Defined');
    clickEntry('PumpState');
    expect(dataTypeView('PumpState').getByRole('tab', { name: 'table' })).toHaveAttribute('aria-selected', 'true');
  });

  it('supports arrow, Home and End keys for datatype tabs without creating main tabs', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    await renderLoadedViewer();
    expandEntry('User Defined');
    clickEntry('PumpState');
    const view = dataTypeView('PumpState');
    const table = view.getByRole('tab', { name: 'table' });
    const other = view.getByRole('tab', { name: 'other' });
    table.focus();
    fireEvent.keyDown(table, { key: 'ArrowRight' });
    expect(other).toHaveFocus();
    expect(other).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(other, { key: 'Home' });
    expect(table).toHaveFocus();
    expect(table).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(table, { key: 'End' });
    expect(other).toHaveFocus();
    fireEvent.keyDown(other, { key: 'ArrowLeft' });
    expect(table).toHaveFocus();
    expect(mainTabs().getAllByRole('tab')).toHaveLength(1);
  });

  it('uses table and other for every datatype category, preserving atomic and unresolved empty states', async () => {
    const categories = [
      ['UserDefined', 'User Defined'], ['String', 'Strings'], ['AddOnDefined', 'Add-On Defined'],
      ['Predefined', 'Predefined'], ['ModuleDefined', 'Module Defined'],
    ];
    const data = metadataController('v1');
    const template = data.dataTypeCatalog[0];
    data.dataTypeCatalog = categories.map(([category]) => ({ ...template, name: `${category}Type`, category,
      resolution: category === 'Predefined' ? 'Atomic' : category === 'ModuleDefined' ? 'Unresolved' : 'Declared', members: [] }));
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data });
    await renderLoadedViewer();
    for (const [category, label] of categories) {
      expandEntry(label);
      clickEntry(`${category}Type`);
      const view = dataTypeView(`${category}Type`);
      expect(view.getByRole('tab', { name: 'table' })).toHaveAttribute('aria-selected', 'true');
      if (category === 'Predefined') expect(view.getByText('This is an atomic data type with no member structure.')).toBeVisible();
      else if (category === 'ModuleDefined') expect(view.getByText(/its member structure is not included in the L5X export/)).toBeVisible();
      else expect(view.getByText('No members are defined for this data type.')).toBeVisible();
      fireEvent.click(view.getByRole('tab', { name: 'other' }));
      expect(view.getByRole('row', { name: `Category ${category}` })).toBeVisible();
    }
    expect(mainTabs().getAllByRole('tab')).toHaveLength(categories.length);
  });

  it('shows a removed datatype safely after refresh without resetting its selected view', async () => {
    queueSuccessfulRead(['v1', 'v2']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      if (version === 'v2') data.dataTypeCatalog.shift();
      return { success: true, data };
    });
    const onShowRaw = vi.fn();
    render(<L5XViewer filePath="/repo/Programs/Main.L5X" onShowRaw={onShowRaw} />);
    await screen.findByText('No Content Selected');
    expandEntry('User Defined');
    clickEntry('PumpState');
    fireEvent.click(dataTypeView('PumpState').getByRole('tab', { name: 'other' }));
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText(/This data type is no longer in the file/)).toBeVisible();
    fireEvent.click(within(screen.getByRole('region', { name: 'Missing data type' })).getByRole('button', { name: 'View Raw' }));
    expect(onShowRaw).toHaveBeenCalledOnce();
    expect(getCachedTabState('/repo/Programs/Main.L5X')?.tabs[0].data).toMatchObject({ type: 'data-type', view: 'other' });
  });

  it('merges legacy metadata and member-table cache entries into the active datatype tab', async () => {
    readTextFileMock.mockResolvedValue({ success: true, content: 'v1' });
    controllerResultMock.mockReturnValue({ success: true, data: metadataController('v1') });
    const viewer = render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('No Content Selected');
    expandEntry('User Defined');
    clickEntry('PumpState');
    viewer.unmount();
    const cached = getCachedTabState('/repo/Programs/Main.L5X')!;
    cached.tabs.push({ id: 'legacy-pump-metadata', type: 'metadata', title: 'PumpState Metadata',
      data: { type: 'metadata', target: { kind: 'data-type', name: 'PumpState' } } });
    cached.activeTabId = 'legacy-pump-metadata';
    render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByRole('tablist', { name: 'PumpState views' });
    expect(mainTabs().getAllByRole('tab')).toHaveLength(1);
    expect(dataTypeView('PumpState').getByRole('tab', { name: 'other' })).toHaveAttribute('aria-selected', 'true');
    expandEntry('User Defined');
    clickEntry('PumpState');
    expect(mainTabs().getAllByRole('tab')).toHaveLength(1);
  });

  it('supplies the complete data type catalog to controller and program tag tables', async () => {
    queueSuccessfulRead(['v1']);
    const controller = makeController('v1', { includeDataTypes: true });
    controller.tags = [{ name: 'ControllerRaw', dataType: 'PumpState' }];
    controller.programs[0].tags = [{ name: 'ProgramRaw', dataType: 'PumpState' }];
    controllerResultMock.mockReturnValue({ success: true, data: controller, errors: [] });

    await renderLoadedViewer();
    clickEntry('Controller Tags');

    expect(tagTableMock.mock.calls[tagTableMock.mock.calls.length - 1]?.[0]).toMatchObject({
      tags: controller.tags,
      dataTypes: controller.dataTypeCatalog,
    });

    expandEntry('MainProgram');
    clickEntry('Program Tags');
    expect(tagTableMock.mock.calls[tagTableMock.mock.calls.length - 1]?.[0]).toMatchObject({
      tags: controller.programs[0].tags,
      dataTypes: controller.dataTypeCatalog,
    });
  });

  it('degrades cleanly when the preserved selection no longer exists after reload', async () => {
    queueSuccessfulRead(['v1', 'missing']);
    controllerResultMock
      .mockReset()
      .mockImplementationOnce(() => ({
        success: true,
        data: makeController('v1'),
        errors: [],
      }))
      .mockImplementationOnce(() => ({
        success: true,
        data: makeController('missing', { includeRoutine: false }),
        errors: [],
      }));

    await renderLoadedViewer();

    openProgramRoutine();
    expect(await screen.findByText('RLL:RoutineA@v1')).toBeInTheDocument();

    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');

    expect(await screen.findByText('Routine not found')).toBeInTheDocument();
  });

  it('renders a program-owned FBD through the normalized routine viewer configuration', async () => {
    queueSuccessfulRead(['v1']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('v1', { routineType: 'FBD' }),
      errors: [],
    }));

    await renderLoadedViewer();
    openProgramRoutine();

    expect(await screen.findByText('FBD:v1:sheet-0')).toBeInTheDocument();
    expect(screen.queryByText(/FBD.*not yet supported/i)).not.toBeInTheDocument();

    const props = latestFBDDiagramProps();
    expect(props).toMatchObject({
      body: { versionTag: 'v1' },
      width: '100%',
      height: '100%',
      className: 'h-full w-full',
      showControls: true,
      showBackground: true,
      showMiniMap: false,
      interactive: true,
      theme: { bgPrimary: 'var(--lv-bg-primary)' },
      sheetIndex: 0,
    });
    expect(props.onDiagnostics).toEqual(expect.any(Function));
    expect(screen.getAllByRole('button', { name: 'Zoom in' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Zoom out' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Fit view' })).toHaveLength(1);
  });

  it('renders an AOI-owned FBD through the same viewer configuration', async () => {
    queueSuccessfulRead(['v1']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('v1', { includeAOIFBD: true }),
      errors: [],
    }));

    await renderLoadedViewer();
    expandEntry('MixerAOI');
    expandEntry('Routines');
    clickEntry('Logic');

    expect(await screen.findByText('FBD:AOI-v1:sheet-0')).toBeInTheDocument();
    expect(latestFBDDiagramProps()).toMatchObject({
      body: { versionTag: 'AOI-v1' },
      width: '100%',
      height: '100%',
      className: 'h-full w-full',
      showControls: true,
      showBackground: true,
      showMiniMap: false,
      interactive: true,
    });
  });

  it('maps nonfatal FBD diagnostics into the viewer warning presentation without reparsing', async () => {
    queueSuccessfulRead(['v1']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('v1', { routineType: 'FBD' }),
      errors: [],
    }));

    await renderLoadedViewer();
    openProgramRoutine();
    await screen.findByText('FBD:v1:sheet-0');
    fireEvent.click(screen.getByRole('button', { name: 'Report FBD diagnostic' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 FBD diagnostic: Unsupported element rendered as a placeholder.',
    );
    expect(controllerResultMock).toHaveBeenCalledTimes(1);
  });

  it('preserves FBD sheet state across app-tab switches and file refreshes', async () => {
    queueSuccessfulRead(['v1', 'v2']);
    controllerResultMock.mockImplementation((content: string) => ({
      success: true,
      data: makeController(content, { routineType: 'FBD' }),
      errors: [],
    }));

    await renderLoadedViewer();
    openProgramRoutine();
    await screen.findByText('FBD:v1:sheet-0');
    fireEvent.click(screen.getByRole('button', { name: 'Next FBD sheet' }));
    expect(await screen.findByText('FBD:v1:sheet-1')).toBeInTheDocument();

    clickEntry('Controller Controller v1');
    expect(screen.getByTitle('Controller Metadata')).toBeInTheDocument();
    fireEvent.click(mainTabs().getByRole('tab', { name: /RoutineA/ }));
    expect(screen.getByText('FBD:v1:sheet-1')).toBeInTheDocument();

    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('FBD:v2:sheet-1')).toBeInTheDocument();
    expect(getCachedContent('l5x:/repo/Programs/Main.L5X')).toMatchObject({
      controller: { name: 'Controller v2' },
    });
  });

  it('keeps FBD sheets per tab when an owner UID becomes ambiguous and its view is reopened', async () => {
    queueSuccessfulRead(['v1', 'v2']);
    controllerResultMock.mockImplementation((version: string) => {
      const data = metadataController(version);
      data.programs = ['DuplicateB', ...(version === 'v2' ? ['DuplicateA'] : [])].map(name => ({
        ...data.programs[0], name, uid: '10', routines: [makeRoutine('RoutineA', 'FBD', `${name}-${version}`)],
      }));
      return { success: true, data };
    });
    const openRoutine = (name: string) => {
      clickEntry(name);
      fireEvent.click(metadataView(name).getByRole('button', { name: 'Open Main routine: RoutineA' }));
    };
    await renderLoadedViewer();
    openRoutine('DuplicateB');
    fireEvent.click(await screen.findByRole('button', { name: 'Next FBD sheet' }));
    expect(screen.getByText('FBD:DuplicateB-v1:sheet-1')).toBeVisible();
    await emitFilesChanged('/repo/Programs/Main.L5X', 'write');
    expect(await screen.findByText('FBD:DuplicateB-v2:sheet-1')).toBeVisible();
    openRoutine('DuplicateB');
    expect(screen.getByText('FBD:DuplicateB-v2:sheet-1')).toBeVisible();
    openRoutine('DuplicateA');
    expect(await screen.findByText('FBD:DuplicateA-v2:sheet-0')).toBeVisible();
    fireEvent.click(within(screen.getByText('FBD:DuplicateA-v2:sheet-0').parentElement!).getByRole('button', { name: 'Next FBD sheet' }));
    openRoutine('DuplicateB');
    expect(screen.getByText('FBD:DuplicateB-v2:sheet-1')).toBeVisible();
    expect(mainTabs().getAllByRole('tab', { name: /RoutineA/ })).toHaveLength(2);
  });

  it('preserves FBD navigation while the CSS palette changes with the app theme', async () => {
    queueSuccessfulRead(['v1']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('v1', { routineType: 'FBD' }),
      errors: [],
    }));

    render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);
    await screen.findByText('No Content Selected');
    openProgramRoutine();
    await screen.findByText('FBD:v1:sheet-0');
    expect(latestFBDDiagramProps().theme).toMatchObject({
      bgPrimary: 'var(--lv-bg-primary)',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next FBD sheet' }));
    expect(screen.getByText('FBD:v1:sheet-1')).toBeInTheDocument();

    act(() => {
      testState.theme = 'dark';
      testState.themeListeners.forEach((listener) => listener());
    });

    await waitFor(() => {
      expect(latestFBDDiagramProps().theme).toMatchObject({
        bgPrimary: 'var(--lv-bg-primary)',
      });
      expect(screen.getByText('FBD:v1:sheet-1')).toBeInTheDocument();
    });
  });

  it('surfaces fatal FBD online-edit rejection through the existing parse error path', async () => {
    queueSuccessfulRead(['online-edit']);
    controllerResultMock.mockReturnValue({
      success: false,
      errors: [{ message: 'Unsupported FBD online-edit representation.' }],
    });

    render(<L5XViewer filePath="/repo/Programs/Main.L5X" />);

    expect(await screen.findByText('Cannot parse L5X file')).toBeInTheDocument();
    expect(screen.getByText(/Unsupported FBD online-edit representation\./)).toBeInTheDocument();
    expect(fbdDiagramMock).not.toHaveBeenCalled();
  });

  it('keeps ST rendering and explains missing SFC source', async () => {
    queueSuccessfulRead(['st']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('st', { routineType: 'ST' }),
      errors: [],
    }));

    await renderLoadedViewer();
    openProgramRoutine();
    expect(await screen.findByText('ST:RoutineA@st')).toBeInTheDocument();

    clearViewerCache();
    clearAllTabStates();
    queueSuccessfulRead(['sfc']);
    controllerResultMock.mockImplementation(() => ({
      success: true,
      data: makeController('sfc', { routineType: 'SFC' }),
      errors: [],
    }));

    const secondView = render(<L5XViewer filePath="/repo/Programs/Other.L5X" />);
    await screen.findByText('No Content Selected');
    openProgramRoutine();
    expect(await screen.findByText('Original XML source is unavailable for this routine.')).toBeInTheDocument();
    secondView.unmount();
  });
});
