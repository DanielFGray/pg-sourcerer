import {
  createCliRenderer,
  ConsolePosition,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  ScrollBoxRenderable,
  type BoxOptions,
  type InputRenderableOptions,
  type SelectRenderableOptions,
  type CliRenderer,
  type RenderContext,
  type StyledText,
} from "@opentui/core";

interface RequiredBaseRow {
  label: string;
  id?: string | number;
  description?: string;
}

interface RowListProps<T extends RequiredBaseRow> {
  rows: T[];
  filterPlaceholder?: string;
  focused?: "input" | "list";
  wrapSelection?: boolean;
  showDescription?: boolean;
  fastScrollStep?: number;
  preview?: PreviewOptions<T>;
  colors?: {
    input?: Partial<
      Pick<
        InputRenderableOptions,
        | "backgroundColor"
        | "textColor"
        | "focusedBackgroundColor"
        | "focusedTextColor"
        | "placeholderColor"
        | "cursorColor"
      >
    >;
    select?: Partial<
      Pick<
        SelectRenderableOptions,
        | "backgroundColor"
        | "textColor"
        | "focusedBackgroundColor"
        | "focusedTextColor"
        | "selectedBackgroundColor"
        | "selectedTextColor"
        | "descriptionColor"
        | "selectedDescriptionColor"
        | "itemSpacing"
        | "fastScrollStep"
      >
    >;
    preview?: {
      backgroundColor?: string;
      textColor?: string;
      borderColor?: string;
    };
  };
  style?: {
    container?: Partial<BoxOptions>;
    filter?: Partial<InputRenderableOptions>;
    list?: Partial<SelectRenderableOptions>;
  };
  onSelect: (rows: T[], indices: number[]) => void;
}

interface RowListInstance<T extends RequiredBaseRow> {
  container: BoxRenderable;
  input: InputRenderable;
  list: SelectRenderable;
  previewBox?: BoxRenderable;
  previewText?: TextRenderable;
  setRows: (rows: T[]) => void;
  focus: (which: "input" | "list") => void;
  destroy: () => void;
  getSelectedRows: () => T[];
  clearSelection: () => void;
  updatePreview: (row: T | undefined) => void;
}

type PreviewPosition = "right" | "bottom" | "none";

export interface PreviewOptions<T> {
  position?: PreviewPosition;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  title?: string;
  onPreview?: (row: T, SelectedRows: T[]) => string | StyledText | undefined;
}

export interface PickerOptions<T extends RequiredBaseRow> {
  filterPlaceholder?: string;
  preview?: PreviewOptions<T>;
}

function normalize(str: string) {
  return (str || "").toLowerCase();
}

function toOptions<T extends RequiredBaseRow>(rows: T[], selectedItems: Set<string>) {
  if (!rows.length) return [{ name: "No results", description: "", value: null }];
  return rows.map(r => {
    const itemKey = r.id !== undefined ? String(r.id) : `${r.label}|${r.description ?? ""}`;
    const isSelected = selectedItems.has(itemKey);
    return {
      name: isSelected ? `☑ ${r.label}` : `☐ ${r.label}`,
      description: r.description ?? "",
      value: r,
    };
  });
}

function parseSize(
  value: number | `${number}%` | undefined,
  defaultValue: number,
): { value: number; isPercent: boolean } {
  if (value === undefined) return { value: defaultValue, isPercent: true };
  if (typeof value === "string" && value.endsWith("%")) {
    return { value: parseFloat(value) / 100, isPercent: true };
  }
  return { value: value as number, isPercent: false };
}

function createRowList<T extends RequiredBaseRow>(
  ctx: CliRenderer | RenderContext,
  {
    rows,
    filterPlaceholder = "Filter...",
    focused,
    wrapSelection,
    showDescription = true,
    fastScrollStep,
    preview,
    colors,
    style,
    onSelect,
  }: RowListProps<T>,
): RowListInstance<T> {
  const previewPosition = preview?.position ?? "none";
  const hasPreview = previewPosition !== "none" && !!preview?.onPreview;

  const isHorizontalLayout = previewPosition === "right";
  const rootContainer = new BoxRenderable(ctx, {
    flexDirection: isHorizontalLayout ? "row" : "column",
    gap: 1,
    ...(style?.container ?? {}),
  });

  const listSection = new BoxRenderable(ctx, {
    flexDirection: "column",
    gap: 0,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 0,
  });

  const input = new InputRenderable(ctx, {
    width: "100%",
    height: 1,
    padding: 1,
    placeholder: filterPlaceholder,
    ...colors?.input,
    ...style?.filter,
  });

  const list = new SelectRenderable(ctx, {
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
    itemSpacing: 0,
    wrapSelection,
    fastScrollStep,
    showDescription,
    ...colors?.select,
    ...style?.list,
  });

  listSection.add(input);
  listSection.add(list);
  rootContainer.add(listSection);

  let previewBox: BoxRenderable | undefined;
  let previewScrollBox: ScrollBoxRenderable | undefined;
  let previewText: TextRenderable | undefined;

  if (hasPreview) {
    const previewColors = colors?.preview ?? {};

    const widthConfig = parseSize(preview?.width, 0.4);
    const heightConfig = parseSize(preview?.height, 0.4);

    previewBox = new BoxRenderable(ctx, {
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: previewColors.borderColor ?? "#555",
      backgroundColor: previewColors.backgroundColor ?? "transparent",
      title: preview?.title ?? "Preview",
      padding: 1,
      ...(isHorizontalLayout
        ? {
            width: widthConfig.isPercent
              ? `${Math.round(widthConfig.value * 100)}%`
              : widthConfig.value,
            flexShrink: 0,
            minHeight: 0,
          }
        : {
            height: heightConfig.isPercent
              ? `${Math.round(heightConfig.value * 100)}%`
              : heightConfig.value,
            flexShrink: 0,
            width: "100%",
          }),
    });

    previewScrollBox = new ScrollBoxRenderable(ctx, {
      flexGrow: 1,
      minHeight: 0,
      minWidth: 0,
    });

    previewText = new TextRenderable(ctx, {
      content: "No item selected",
      fg: previewColors.textColor ?? "#aaa",
      wrapMode: "word",
      width: "100%",
    });

    previewScrollBox.add(previewText);
    previewBox.add(previewScrollBox);
    rootContainer.add(previewBox);
  }

  let allRows = rows.slice();
  let filteredRows = allRows.slice();
  const selectedItems = new Set<string>();

  const getItemKey = (row: T): string => {
    return row.id !== undefined ? String(row.id) : `${row.label}|${row.description ?? ""}`;
  };

  const updateList = () => {
    list.options = toOptions(filteredRows, selectedItems);
    const hasDescriptions = filteredRows.some(r => (r.description ?? "").trim());
    list.showDescription = !!showDescription && hasDescriptions;
  };

  const updatePreview = (row: T | undefined) => {
    if (!hasPreview || !previewText || !preview?.onPreview) return;

    if (!row) {
      previewText.content = "No item selected";
      return;
    }

    const content = preview.onPreview(
      row,
      Array.from(selectedItems, key => allRows.find(r => r.id == key)!),
    );
    if (content === undefined) {
      previewText.content = "";
    } else {
      previewText.content = content;
    }

    previewScrollBox?.scrollTo(0);
  };

  updateList();

  if (filteredRows.length > 0) {
    updatePreview(filteredRows[0]);
  }

  input.on(InputRenderableEvents.INPUT, (value: string) => {
    const ft = normalize(value);
    if (!ft) {
      filteredRows = allRows.slice();
    } else {
      filteredRows = allRows.filter(r => {
        const label = normalize(r.label);
        const desc = normalize(r.description ?? "");
        return label.includes(ft) || (!!desc && desc.includes(ft));
      });
    }
    updateList();

    if (filteredRows.length > 0) {
      updatePreview(filteredRows[list.getSelectedIndex()] ?? filteredRows[0]);
    } else {
      updatePreview(undefined);
    }
  });

  list.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    const row = filteredRows[index];
    updatePreview(row);
  });

  const handleEnterKey = () => {
    const selectedRows = allRows.filter(row => selectedItems.has(getItemKey(row)));
    const selectedIndices = selectedRows.map(row => allRows.indexOf(row)).filter(i => i >= 0);

    if (selectedRows.length > 0) {
      onSelect(selectedRows, selectedIndices);
    } else {
      const currentIndex = list.getSelectedIndex();
      const currentRow = filteredRows[currentIndex];
      if (currentRow) {
        const actualIndex = allRows.indexOf(currentRow);
        onSelect([currentRow], [actualIndex >= 0 ? actualIndex : currentIndex]);
      }
    }
  };

  const handleTabKey = (shift: boolean) => {
    const currentIndex = list.getSelectedIndex();
    const currentRow = filteredRows[currentIndex];

    if (currentRow) {
      const itemKey = getItemKey(currentRow);
      if (selectedItems.has(itemKey)) {
        selectedItems.delete(itemKey);
      } else {
        selectedItems.add(itemKey);
      }
    }

    let nextIndex;
    if (shift) {
      nextIndex = currentIndex - 1 < 0 ? filteredRows.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex + 1 >= filteredRows.length ? 0 : currentIndex + 1;
    }
    list.setSelectedIndex(nextIndex);
    updateList();
  };

  const prevInputOnKeyDown = input.onKeyDown;
  input.onKeyDown = key => {
    const step = key.shift ? (fastScrollStep ?? 5) : 1;
    if (key.name === "up") {
      list.moveUp(step);
    } else if (key.name === "down") {
      list.moveDown(step);
    } else if (key.name === "enter" || key.name === "return") {
      handleEnterKey();
    } else if (key.name === "tab") {
      handleTabKey(!!key.shift);
    }
    prevInputOnKeyDown?.(key);
  };

  const prevListOnKeyDown = list.onKeyDown;
  list.onKeyDown = key => {
    if (key.name === "tab") {
      handleTabKey(!!key.shift);
      return;
    } else if (key.name === "enter" || key.name === "return") {
      handleEnterKey();
      return;
    }
    prevListOnKeyDown?.(key);
  };

  const initialFocus = focused ?? "input";
  if (initialFocus === "input") input.focus();
  else list.focus();

  const setRows = (rowsNext: T[]) => {
    allRows = rowsNext.slice();
    const ft = normalize(input.value || "");
    if (!ft) {
      filteredRows = allRows.slice();
    } else {
      filteredRows = allRows.filter(r => {
        const label = normalize(r.label);
        const desc = normalize(r.description ?? "");
        return label.includes(ft) || (!!desc && desc.includes(ft));
      });
    }
    selectedItems.clear();
    updateList();

    if (filteredRows.length > 0) {
      updatePreview(filteredRows[0]);
    } else {
      updatePreview(undefined);
    }
  };

  const getSelectedRows = (): T[] => {
    return allRows.filter(row => selectedItems.has(getItemKey(row)));
  };

  const clearSelection = (): void => {
    selectedItems.clear();
    updateList();
  };

  return {
    container: rootContainer,
    input,
    list,
    previewBox,
    previewText,
    setRows,
    focus: w => (w === "input" ? input.focus() : list.focus()),
    destroy: () => rootContainer.destroyRecursively(),
    getSelectedRows,
    clearSelection,
    updatePreview,
  };
}

export async function picker<T extends RequiredBaseRow>(
  rows: T[],
  options: PickerOptions<T> = {},
): Promise<null | T[]> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      startInDebugMode: true,
    },
  });
  renderer.setBackgroundColor("transparent");

  return new Promise<null | T[]>(resolve => {
    (renderer.keyInput as any).on("keypress", (key: any) => {
      if (key.ctrl && key.name === "c") {
        resolve(null);
      }
    });

    const rootContainer = createRowList(renderer, {
      rows,
      filterPlaceholder:
        options.filterPlaceholder ?? "Type to filter... (Tab: select next, Enter: confirm)",
      wrapSelection: true,
      showDescription: true,
      preview: options.preview,
      colors: {
        input: {},
        select: {},
        preview: {},
      },
      style: {
        container: {
          flexGrow: 1,
          minHeight: 10,
          height: "100%",
        },
        list: { showScrollIndicator: true },
      },
      onSelect: resolve,
    });

    renderer.root.add(rootContainer.container);
    renderer.start();
  }).finally(() => {
    renderer.destroy();
    renderer.disableStdoutInterception();
  });
}

export { createRowList };
export type { RowListProps, RowListInstance };
