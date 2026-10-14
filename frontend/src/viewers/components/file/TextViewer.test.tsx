import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { clearViewerCache } from '../../registry/viewer-cache';
import TextViewer from './TextViewer';

const { read, onEvent, unsubscribe } = vi.hoisted(() => ({ read: vi.fn(), onEvent: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../../../../bindings/iofabrik/services/filesystemservice', () => ({ ReadTextFile: read }));
vi.mock('../../../shared/runtime/events', () => ({ onEvent }));
let changed: (event: unknown) => void;
beforeEach(() => {
  vi.resetAllMocks();
  clearViewerCache();
  onEvent.mockImplementation((_name, handler) => { changed = handler; return unsubscribe; });
});

describe('TextViewer loading and refresh', () => {
  it('loads lazily, retains the same editor and selection through refresh, and unsubscribes', async () => {
    read.mockResolvedValueOnce({ success: true, content: 'one\ntwo\nthree' });
    const { container, unmount } = render(<TextViewer filePath={'C:\\work\\source.txt'} />);
    expect(screen.getByText('Loading source.txt...')).toBeInTheDocument();
    const content = await screen.findByRole('textbox', { name: 'File content' });
    const view = EditorView.findFromDOM(content)!;
    act(() => view.dispatch({ selection: { anchor: 4, head: 7 } }));
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    act(() => changed({ data: { path: 'C:/work/source.txt', eventType: 'write' } }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing file...');
    expect(container.querySelector('.cm-content')).toBe(content);
    await act(async () => finish({ success: true, content: 'one\ntwo\nupdated' }));
    expect(EditorView.findFromDOM(content)).toBe(view);
    expect(view.state.selection.main.anchor).toBe(4);
    expect(view.state.selection.main.head).toBe(7);
    expect(view.state.sliceDoc()).toBe('one\ntwo\nupdated');
    act(() => changed({ data: { path: 'C:/work/other.txt', eventType: 'write' } }));
    expect(read).toHaveBeenCalledTimes(2);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.querySelector('.cm-editor')).toBeNull();
  });

  it('reopens cached empty files and recreates a disposed editor', async () => {
    read.mockResolvedValue({ success: true, content: '' });
    const first = render(<TextViewer filePath="/empty.txt" />);
    const before = await screen.findByRole('textbox', { name: 'File content' });
    expect(screen.getByText('This file is empty.')).toBeInTheDocument();
    first.unmount();
    render(<TextViewer filePath="/empty.txt" />);
    const after = await screen.findByRole('textbox', { name: 'File content' });
    expect(before).not.toBe(after);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['This file is too large to view as text (maximum 10 MB).', 'File not found.'])('preserves the backend error state: %s', async error => {
    read.mockResolvedValue({ success: false, error });
    render(<TextViewer filePath="/source.txt" />);
    expect(await screen.findByText('Cannot display file')).toBeInTheDocument();
    expect(screen.getByText(error)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'File content' })).not.toBeInTheDocument();
  });

  it('updates Find results after an external refresh', async () => {
    read.mockResolvedValueOnce({ success: true, content: 'first' });
    render(<TextViewer filePath="/source.txt" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Find' }));
    fireEvent.change(screen.getByLabelText('Find in file'), { target: { value: 'added' } });
    expect(screen.getByRole('status')).toHaveTextContent('No results');
    read.mockResolvedValueOnce({ success: true, content: 'first\nadded' });
    act(() => changed({ data: { path: '/source.txt', eventType: 'write' } }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  });
});
