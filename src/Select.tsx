import {
  Children,
  isValidElement,
  useMemo,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Select as Primitive } from '@base-ui/react/select';
import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, Search } from 'lucide-react';

type Option = { value: string; label: string; disabled?: boolean };
type Props = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'onChange' | 'value' | 'defaultValue'
> & {
  value?: string;
  defaultValue?: string;
  searchable?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
};
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((n) =>
      isValidElement<{ children?: ReactNode }>(n)
        ? text(n.props.children)
        : String(n),
    )
    .join('');
}
// Accept option declarations at the call site so labels, form names and defaults
// stay together. Base UI owns keyboard navigation, focus and form participation.
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  name,
  id,
  required,
  disabled,
  searchable,
  className = '',
  'aria-label': label,
  ...rest
}: Props) {
  const items = useMemo(
    () =>
      Children.toArray(children)
        .filter(isValidElement)
        .map((child) => {
          const p = (
            child as React.ReactElement<{
              value: string;
              children: ReactNode;
              disabled?: boolean;
            }>
          ).props;
          return {
            value: String(p.value),
            label: text(p.children),
            disabled: p.disabled,
          };
        }),
    [children],
  );
  const common = { name, id, required, disabled };
  const initial = defaultValue ?? items[0]?.value;
  if (searchable) {
    return (
      <Combobox.Root<Option>
        {...common}
        items={items}
        value={
          value === undefined
            ? undefined
            : (items.find((i) => i.value === value) ?? null)
        }
        defaultValue={
          value === undefined
            ? items.find((i) => i.value === initial)
            : undefined
        }
        isItemEqualToValue={(a, b) => a.value === b.value}
        onValueChange={(item) => {
          if (item) onChange?.({ target: { value: item.value } });
        }}
      >
        <Combobox.Trigger
          className={`select-trigger ${className}`}
          aria-label={label}
          title={rest.title}
        >
          <Combobox.Value>
            {(item: Option | null) => item?.label ?? 'Choose…'}
          </Combobox.Value>
          <ChevronDown size={15} />
        </Combobox.Trigger>
        <Combobox.Portal>
          <Combobox.Positioner className="choice-positioner" sideOffset={6}>
            <Combobox.Popup className="choice-popup">
              <div className="choice-search">
                <Search size={15} />
                <Combobox.Input
                  aria-label="Filter options"
                  placeholder="Search…"
                />
              </div>
              <Combobox.Empty className="choice-empty">
                No matches.
              </Combobox.Empty>
              <Combobox.List>
                {(item: Option) => (
                  <Combobox.Item
                    className="choice-item"
                    key={item.value}
                    value={item}
                    disabled={item.disabled}
                  >
                    <span>{item.label}</span>
                    <Combobox.ItemIndicator>
                      <Check size={15} />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    );
  }
  return (
    <Primitive.Root<string>
      {...common}
      items={items}
      value={value}
      defaultValue={value === undefined ? initial : undefined}
      onValueChange={(next) => {
        if (next !== null) onChange?.({ target: { value: next } });
      }}
    >
      <Primitive.Trigger
        className={`select-trigger ${className}`}
        aria-label={label}
        title={rest.title}
      >
        <Primitive.Value />
        <Primitive.Icon>
          <ChevronDown size={15} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Positioner
          className="choice-positioner"
          sideOffset={6}
          alignItemWithTrigger={false}
        >
          <Primitive.Popup className="choice-popup">
            <Primitive.List>
              {items.map((item) => (
                <Primitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  className="choice-item"
                >
                  <Primitive.ItemText>{item.label}</Primitive.ItemText>
                  <Primitive.ItemIndicator>
                    <Check size={15} />
                  </Primitive.ItemIndicator>
                </Primitive.Item>
              ))}
            </Primitive.List>
          </Primitive.Popup>
        </Primitive.Positioner>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
