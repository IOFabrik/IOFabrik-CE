import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diffEncodedData,
  diffFBD,
  FBDDiffDiagram,
  parseDocumentString,
  parseString,
  RawRoutineViewer,
  TagTable,
  type PlcDocument,
} from 'ladder-visualizer';
import { IOFABRIK_LADDER_THEME } from './theme';

const FBD_WITH_DECORATED_BLOCK_DATA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="35.01" TargetName="GenericBlocks" TargetType="Program" ContainsContext="true" ExportOptions="References NoRawData L5KData DecoratedData Context">
  <Controller Use="Context" Name="FixtureController" ProcessorType="1756-L85E">
    <Programs>
      <Program Name="GenericBlocks">
        <Tags>
          <Tag Name="BLOCK_01" TagType="Base" DataType="FBD_TEST">
            <Data Format="Decorated">
              <Structure DataType="FBD_TEST">
                <DataValueMember Name="EnableIn" DataType="BOOL" Value="1" />
                <DataValueMember Name="InA" DataType="REAL" Value="0" />
                <DataValueMember Name="EnableOut" DataType="BOOL" Value="0" />
                <DataValueMember Name="OutA" DataType="REAL" Value="0" />
              </Structure>
            </Data>
          </Tag>
        </Tags>
        <Routines>
          <Routine Name="Logic" Type="FBD">
            <FBDContent SheetSize="Tabloid - 11 x 17 in" SheetOrientation="Landscape">
              <Sheet Number="1">
                <Block Type="TEST" ID="1" X="20" Y="20" Operand="BLOCK_01" VisiblePins="InA OutA" />
              </Sheet>
            </FBDContent>
          </Routine>
        </Routines>
      </Program>
    </Programs>
  </Controller>
</RSLogix5000Content>`;

function rawUdtArraySource(softwareRevision: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="${softwareRevision}" TargetName="RawUdtArray" TargetType="Controller" ContainsContext="false" ExportOptions="DecoratedData">
  <Controller Use="Target" Name="RawUdtArray">
    <DataTypes>
      <DataType Name="InnerType" Family="NoFamily" Class="User">
        <Members><Member Name="Value" DataType="DINT" Dimension="0" Radix="Decimal" Hidden="false" /></Members>
      </DataType>
      <DataType Name="SOE_Data" Family="NoFamily" Class="User">
        <Members>
          <Member Name="Events" DataType="InnerType" Dimension="2" Radix="NullType" Hidden="false" />
          <Member Name="ZZZZZZZZZZSOE_Data0" DataType="SINT" Dimension="0" Radix="Decimal" Hidden="true" />
          <Member Name="Enabled" DataType="BIT" Dimension="0" Radix="Decimal" Hidden="false" Target="ZZZZZZZZZZSOE_Data0" BitNumber="0" />
        </Members>
      </DataType>
    </DataTypes>
    <Programs><Program Name="MainProgram"><Tags>
      <Tag Name="RawEvents" TagType="Base" DataType="SOE_Data" Dimensions="2"><Data>00 00 00 00 00 00 00 00</Data></Tag>
    </Tags></Program></Programs>
  </Controller>
</RSLogix5000Content>`;
}

describe('pinned ladder-visualizer package', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exposes document payloads and encoded comparison through the public API', () => {
    const source = `<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="35.01" TargetName="Secret" TargetType="Routine" ContainsContext="true">
      <Controller Use="Context" Name="FixtureController"><Programs><Program Name="Main"><Routines>
        <EncodedData Name="Secret" Type="RLL" EncodedType="Routine"><![CDATA[synthetic-old-payload]]></EncodedData>
      </Routines></Program></Programs></Controller>
    </RSLogix5000Content>`;
    const before = parseDocumentString(source, 'l5x');
    const after = parseDocumentString(source.replace('old-payload', 'new-payload'), 'l5x');

    expect(before).toMatchObject({ success: true, status: 'partial' });
    expect(after.success).toBe(true);
    expect(before.data?.encodedData[0]).toMatchObject({
      payload: 'synthetic-old-payload',
      capabilities: { inspectPayload: true, decodedView: false, semanticQuery: false },
    });
    expect(before.data?.targetIds).toContain(before.data?.encodedData[0]?.sourcePath);
    if (!before.data || !after.data) throw new Error('Expected parsed documents');
    const document: PlcDocument = before.data;
    expect(diffEncodedData(document, document)).toMatchObject([{ kind: 'unchanged' }]);
    expect(diffEncodedData(document, after.data)).toMatchObject([{ kind: 'changed' }]);
  });

  it('compares and renders FBD revisions using the central theme', () => {
    // jsdom has no layout observer; browser layout is verified separately.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const before = parseString(FBD_WITH_DECORATED_BLOCK_DATA, 'l5x');
    const after = parseString(FBD_WITH_DECORATED_BLOCK_DATA.replace('X="20"', 'X="80"'), 'l5x');
    const oldBody = before.data?.programs[0]?.routines[0]?.fbd;
    const newBody = after.data?.programs[0]?.routines[0]?.fbd;
    expect(oldBody).toBeDefined();
    expect(newBody).toBeDefined();
    expect(diffFBD(oldBody, oldBody).hasChanges).toBe(false);
    expect(diffFBD(oldBody, newBody)).toMatchObject({
      hasChanges: true,
      complete: true,
      sheets: [{ elements: [{ kind: 'modified', categories: ['presentation'] }] }],
    });

    render(createElement(FBDDiffDiagram, { oldBody, newBody, theme: IOFABRIK_LADDER_THEME }));
    expect(screen.getByRole('button', { name: 'Overlay' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves SFC XML for the public raw routine viewer', () => {
    const routineXml = `<Routine Name="Sequence" Type="SFC"><SFCContent><!-- keep source -->
      <Step ID="1" X="20" Y="20" Operand="Stage_1" InitialStep="true" />
    </SFCContent></Routine>`;
    const source = `<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="35.01" TargetName="FixtureController" TargetType="Controller" ContainsContext="false">
      <Controller Use="Target" Name="FixtureController"><Programs><Program Name="Main"><Routines>
        ${routineXml}
      </Routines></Program></Programs></Controller>
    </RSLogix5000Content>`;
    const result = parseString(source, 'l5x');
    const routine = result.data?.programs[0]?.routines[0];
    expect(result).toMatchObject({ success: true, status: 'partial' });
    expect(routine?.rawSource?.text).toBe(routineXml);
    if (!routine) throw new Error('Expected an SFC routine');
    render(createElement(RawRoutineViewer, { routine }));
    const region = screen.getByRole('region', { name: 'Sequence XML source' });
    expect(region.querySelector('code')?.textContent).toBe(routineXml);
    expect(region.querySelector('Step')).toBeNull();
  });

  it('infers FBD Block ports from decorated program data', () => {
    const result = parseString(FBD_WITH_DECORATED_BLOCK_DATA, 'l5x');
    const block = result.data?.programs[0]?.routines[0]?.fbd?.sheets[0]?.elements.find(
      (element) => element.kind === 'block',
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe('complete');
    expect(block?.kind).toBe('block');
    if (block?.kind !== 'block') return;

    expect(block.ports.map(({ id, dataType, direction, visible }) => ({
      id,
      dataType,
      direction,
      visible,
    }))).toEqual([
      { id: 'InA', dataType: 'REAL', direction: 'input', visible: true },
      { id: 'OutA', dataType: 'REAL', direction: 'output', visible: true },
    ]);
  });

  it.each(['33.00', '34.01', '35.01'])(
    'renders raw-only UDT arrays from the declared v%s type catalog',
    (softwareRevision) => {
      const result = parseString(rawUdtArraySource(softwareRevision), 'l5x');
      const controller = result.data;
      const tag = controller?.programs[0]?.tags[0];

      expect(result).toMatchObject({ success: true, status: 'partial' });
      expect(tag).toBeDefined();
      if (!controller || !tag) return;

      render(createElement(TagTable, {
        tags: [tag],
        dataTypes: controller.dataTypeCatalog ?? controller.dataTypes,
      }));

      expect(screen.queryByText('00 00 00 00 00 00 00 00')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Expand RawEvents' }));
      expect(screen.getByText('RawEvents[0]')).toBeInTheDocument();
      expect(screen.getByText('RawEvents[1]')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Expand RawEvents[0]' }));
      expect(screen.getByText('RawEvents[0].Events')).toBeInTheDocument();
      const enabledName = screen.getByText('RawEvents[0].Enabled');
      expect(enabledName.closest('tr')).toHaveTextContent('BOOL');
      expect(screen.queryByText('RawEvents[0].ZZZZZZZZZZSOE_Data0')).not.toBeInTheDocument();
    },
  );
});
