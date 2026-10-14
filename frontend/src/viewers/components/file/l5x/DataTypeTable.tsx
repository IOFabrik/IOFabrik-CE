import { memo, type ReactNode } from 'react';
import type { NormalizedDataType, NormalizedDataTypeMember } from 'ladder-visualizer';

export interface DataTypeTableProps {
  dataType: NormalizedDataType;
  allDataTypes?: NormalizedDataType[];
  onDataTypeSelect?: (dataType: NormalizedDataType) => void;
  className?: string;
}

/**
 * IOFabrik-native presentation for Ladder Visualizer's normalized data types.
 * Keep its behavior aligned with the package component while using app theme tokens.
 */
export const DataTypeTable = memo(function DataTypeTable({
  dataType,
  allDataTypes = [],
  onDataTypeSelect,
  className = '',
}: DataTypeTableProps) {
  const renderTypeReference = (member: NormalizedDataTypeMember): ReactNode => {
    const target = allDataTypes.find(
      (candidate) => candidate.name === member.dataType && candidate.name !== dataType.name,
    );

    if (!target || !onDataTypeSelect) {
      return member.dataType;
    }

    return (
      <button
        type="button"
        className="rounded-sm text-left underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-theme-primary"
        style={{ color: 'var(--color-accent-primary)' }}
        onClick={() => onDataTypeSelect(target)}
        title={`Open ${target.name}`}
        aria-label={`Open ${target.name}`}
      >
        {member.dataType}
      </button>
    );
  };

  return (
    <section
      className={`flex h-full min-h-0 flex-col gap-3 text-theme-primary ${className}`.trim()}
      aria-labelledby={`data-type-${dataType.name}`}
    >
      <header className="shrink-0 rounded-md border border-theme-default bg-theme-elevated px-4 py-3">
        <h2 id={`data-type-${dataType.name}`} className="m-0 text-sm font-semibold text-theme-primary">
          {dataType.name}
        </h2>
        {dataType.description ? (
          <p className="mt-1.5 text-xs leading-5 text-theme-secondary">{dataType.description}</p>
        ) : null}
      </header>

      {dataType.members.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-theme-default bg-theme-surface">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-theme-elevated">
              <tr className="border-b border-theme-default">
                <ColumnHeader className="w-[28%]">Name</ColumnHeader>
                <ColumnHeader className="w-[28%]">Data Type</ColumnHeader>
                <ColumnHeader>Description</ColumnHeader>
              </tr>
            </thead>
            <tbody>
              {dataType.members.map((member, index) => (
                <tr
                  key={`${member.name}-${index}`}
                  className="border-b border-theme-default transition-colors last:border-b-0 hover:bg-theme-hover/50"
                >
                  <DataCell className="font-mono text-theme-primary">{member.name}</DataCell>
                  <DataCell className="font-mono text-theme-secondary">
                    {renderTypeReference(member)}
                  </DataCell>
                  <DataCell className="text-theme-secondary">{member.description ?? '—'}</DataCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-md border border-theme-default bg-theme-elevated px-4 py-6 text-center text-xs text-theme-secondary">
          {emptyStateText(dataType)}
        </div>
      )}
    </section>
  );
});

function ColumnHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left font-medium text-theme-muted ${className}`.trim()}>
      {children}
    </th>
  );
}

function DataCell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className}`.trim()}>{children}</td>;
}

function emptyStateText(dataType: NormalizedDataType): string {
  if (dataType.resolution === 'Atomic') {
    return 'This is an atomic data type with no member structure.';
  }
  if (dataType.resolution === 'Unresolved') {
    return 'This data type is referenced by the project, but its member structure is not included in the L5X export.';
  }
  return 'No members are defined for this data type.';
}
