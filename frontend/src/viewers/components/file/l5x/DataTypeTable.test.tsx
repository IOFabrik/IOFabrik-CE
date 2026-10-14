import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedDataType } from 'ladder-visualizer';

import { DataTypeTable } from './DataTypeTable';

const nestedType: NormalizedDataType = {
  name: 'ValveState',
  class: 'User',
  category: 'UserDefined',
  resolution: 'Declared',
  members: [],
};

const dataType: NormalizedDataType = {
  name: 'ValveControl',
  class: 'AddOnDefined',
  category: 'AddOnDefined',
  resolution: 'Declared',
  description: 'Controls one valve.',
  members: [
    {
      name: 'EnableIn',
      dataType: 'BOOL',
      dimension: 0,
      dimensions: [],
      description: 'Enables execution.',
    },
    {
      name: 'State',
      dataType: 'ValveState',
      dimension: 0,
      dimensions: [],
      description: 'Current valve state.',
    },
  ],
};

describe('DataTypeTable', () => {
  it('matches the shared component behavior using IOFabrik table styling', () => {
    const onDataTypeSelect = vi.fn();

    render(
      <DataTypeTable
        dataType={dataType}
        allDataTypes={[dataType, nestedType]}
        onDataTypeSelect={onDataTypeSelect}
      />,
    );

    expect(screen.getByRole('heading', { name: 'ValveControl' })).toBeInTheDocument();
    expect(screen.getByText('Controls one valve.')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Name',
      'Data Type',
      'Description',
    ]);
    expect(screen.queryByText('Dimensions')).not.toBeInTheDocument();
    expect(screen.queryByText('External Access')).not.toBeInTheDocument();

    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('EnableInBOOLEnables execution.');
    expect(rows[2]).toHaveTextContent('StateValveStateCurrent valve state.');

    fireEvent.click(screen.getByRole('button', { name: 'Open ValveState' }));
    expect(onDataTypeSelect).toHaveBeenCalledWith(nestedType);
  });

  it.each([
    ['Atomic', 'This is an atomic data type with no member structure.'],
    ['Unresolved', 'This data type is referenced by the project, but its member structure is not included in the L5X export.'],
    ['Declared', 'No members are defined for this data type.'],
  ] as const)('renders the %s empty state consistently with Ladder Visualizer', (resolution, message) => {
    render(
      <DataTypeTable
        dataType={{
          name: `${resolution}Type`,
          class: 'BuiltIn',
          category: 'Predefined',
          resolution,
          members: [],
        }}
      />,
    );

    expect(screen.getByText(message)).toBeInTheDocument();
  });
});
