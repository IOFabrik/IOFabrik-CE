import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadTextFile } from '../../../../bindings/iofabrik/services/filesystemservice';
import { parseDocumentString } from 'ladder-visualizer';
import { clearViewerCache, getCachedContent } from '../../registry/viewer-cache';
import { clearAllTabStates } from './l5x/useTabs';
import L5XFileViewer from './L5XFileViewer';

vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({ ReadTextFile: vi.fn() }));
vi.mock('../../../shared/runtime/events', () => ({ onEvent: () => vi.fn() }));
vi.mock('../shared/ViewerHeader', () => ({ ViewerHeader: ({ extraContent }: { extraContent: React.ReactNode }) => <div>{extraContent}</div> }));
vi.mock('../shared/L5XProjectOrganizer', () => ({ default: ({ controller }: { controller: { name: string } }) => <div>{controller.name} navigation</div> }));
vi.mock('ladder-visualizer', async importOriginal => {
  const actual = await importOriginal<typeof import('ladder-visualizer')>();
  return { ...actual, parseDocumentString: vi.fn(actual.parseDocumentString) };
});
const fixture = (name: string) => readFileSync(`src/viewers/components/shared/__fixtures__/l5x/${name}.L5X`, 'utf8');
const filePath = '/repo/Main.L5X';

describe('L5X file document results', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    clearViewerCache();
    clearAllTabStates();
    vi.clearAllMocks();
  });

  it.each([
    ['controller-rll-v35', 'Supported content loaded'],
    ['document-envelope-v35', 'Some content needs source inspection'],
    ['document-encoded-v35', 'Some content needs source inspection'],
    ['malformed-truncated-v35', 'Cannot parse L5X file'],
  ])('loads and caches the complete %s result once', async (name, status) => {
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content: fixture(name) });
    const view = render(<L5XFileViewer filePath={filePath} />);
    await screen.findByText(status);
    expect(parseDocumentString).toHaveBeenCalledTimes(1);
    expect(getCachedContent(`l5x:${filePath}`)).toHaveProperty('status');
    view.unmount();
    render(<L5XFileViewer filePath={filePath} />);
    await screen.findByText(status);
    expect(ReadTextFile).toHaveBeenCalledTimes(1);
    expect(parseDocumentString).toHaveBeenCalledTimes(1);
  });

  it('keeps encoded source reachable without presenting an empty project as the export target', async () => {
    const content = fixture('document-encoded-v35');
    vi.mocked(ReadTextFile).mockResolvedValue({ success: true, content });
    render(<L5XFileViewer filePath={filePath} />);
    await screen.findByRole('heading', { name: 'Secret payload' });
    expect(screen.getByText(/Decoded visualization and semantic operations are unavailable/)).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: 'View Raw' })[0]);
    const textBox = await screen.findByRole('textbox', { name: 'File content' });
    expect(EditorView.findFromDOM(textBox)!.state.sliceDoc()).toBe(content);
    expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true');
  });
});
