import { describe, expect, it } from 'vitest';
import { isActivePreviewStagingPath } from './preview-staging';
import type { PreviewNotificationState } from '../hooks/usePreviewGeneration';

const operation: PreviewNotificationState = { operationId: 'test-id', startedAt: 0, repoPath: 'C:\\Project', filePath: 'C:\\Project\\PLC\\Controller.ACD', status: 'running', message: 'Publishing…' };
describe('active preview publication workspace', () => {
  it.each(['PLC/.iofabrik-preview-test-id', '.\\PLC\\.iofabrik-preview-test-id\\', 'c:\\project\\plc\\.iofabrik-preview-test-id\\new\\content.xml'])( 'hides its own workspace: %s', path => {
    expect(isActivePreviewStagingPath(path, operation)).toBe(true);
  });
  it.each(['PLC/Controller.preview', 'PLC/.iofabrik-preview-other', 'PLC/.iofabrik-preview-test-id-not-ours', '.iofabrik-preview-test-id', 'Other/PLC/.iofabrik-preview-test-id'])( 'preserves other project content: %s', path => {
    expect(isActivePreviewStagingPath(path, operation)).toBe(false);
  });
  it('keeps recovery remnants visible after failure and uses case-sensitive paths on POSIX', () => {
    expect(isActivePreviewStagingPath('PLC/.iofabrik-preview-test-id', { ...operation, status: 'error' })).toBe(false);
    expect(isActivePreviewStagingPath('PLC/.iofabrik-preview-test-id')).toBe(false);
    const posix = { ...operation, repoPath: '/Project', filePath: '/Project/PLC/Controller.ACD' };
    expect(isActivePreviewStagingPath('PLC/.iofabrik-preview-test-id/new', posix)).toBe(true);
    expect(isActivePreviewStagingPath('plc/.iofabrik-preview-test-id', posix)).toBe(false);
  });
});
