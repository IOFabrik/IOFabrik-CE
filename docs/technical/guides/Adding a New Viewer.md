# Adding a New Viewer

> Step-by-step guide for creating file viewers and diff viewers.

## Prerequisites

- Understanding of [Viewer System](../frontend/Viewer%20System.md)
- Familiarity with [Frontend Architecture](../frontend/Frontend%20Architecture.md)

## Steps for a File Viewer

### 1. Create the Viewer Component

Create `frontend/src/viewers/components/file/MyFormatViewer.tsx`:

```tsx
import { memo } from 'react';
import type { ViewerProps } from '../../registry/viewer-registry';

function MyFormatViewer({ filePath }: ViewerProps) {
    // Load and display file content
    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 overflow-auto p-4">
                {/* Render file content */}
            </div>
        </div>
    );
}

export default memo(MyFormatViewer);
```

### 2. Register the Viewer

Edit `frontend/src/viewers/registry/builtins.ts`:

```tsx
import { lazy } from 'react';
import { registerViewer } from './viewer-registry';
import { FileCode } from 'lucide-react';

// Lazy load for heavy viewers
const MyFormatViewer = lazy(() => import('../components/file/MyFormatViewer'));

registerViewer({
    id: 'my-format',
    name: 'My Format Viewer',
    icon: FileCode,
    component: MyFormatViewer,
    canHandle: (fileName) => {
        const ext = fileName.toLowerCase().split('.').pop();
        return ['myext', 'myformat'].includes(ext || '');
    },
    priority: 0,    // Higher = checked first
    builtIn: true,   // Cannot be unregistered
});
```

### 3. (Optional) Add a Diff Viewer

Create `frontend/src/viewers/components/diff/MyFormatDiffViewer.tsx` and register in `diff-builtins.tsx` with the same pattern.

## canHandle Function

The `canHandle` function determines if this viewer can display a file:

```tsx
// Simple extension matching
canHandle: (fileName) => fileName.toLowerCase().endsWith('.myext')

// Multiple extensions
canHandle: (fileName) => {
    const ext = fileName.toLowerCase().split('.').pop();
    return ['ext1', 'ext2', 'ext3'].includes(ext || '');
}

// Magic number detection (for binary files)
canHandle: (fileName, contentPeek) => {
    if (fileName.endsWith('.mybin')) return true;
    if (contentPeek && contentPeek[0] === 0x89 && contentPeek[1] === 0x50) return true;
    return false;
}
```

## Priority

- **Higher priority** = checked first
- Built-in viewers use priority 0
- L5X viewer uses priority 1 (takes precedence over text viewer for .L5X files)
- `UnsupportedViewer` uses priority -1 (fallback)
- Use priority > 0 to override built-in viewers

## Lazy Loading

For heavy viewers (PDF, 3D, L5X), use `React.lazy()`:

```tsx
const HeavyViewer = lazy(() => import('../components/file/HeavyViewer'));
```

The viewer system wraps lazy components in `<Suspense>` with a loading spinner automatically.

## ViewerProps

```tsx
interface ViewerProps {
    filePath: string          // Absolute path to the file
    contentPeek?: Uint8Array  // First N bytes for content detection
}
```

To read file content, use the [FileSystemService](../backend/services/FileSystemService.md) bindings:
```tsx
import { ReadTextFile, ReadFileBase64 } from '../../../bindings/iofabrik/services/filesystemservice';
```

## Checklist

- [ ] Viewer component created in `viewers/components/file/`
- [ ] Registered in `builtins.ts` with correct `canHandle` and priority
- [ ] Uses `React.lazy()` if heavy (large dependencies)
- [ ] Uses `memo()` for performance
- [ ] Error boundary handles failures gracefully
- [ ] (Optional) Diff viewer created and registered
- [ ] Tested with sample files

---

**Related:** [Viewer System](../frontend/Viewer%20System.md) | [Frontend Architecture](../frontend/Frontend%20Architecture.md) | [FileSystemService](../backend/services/FileSystemService.md)
