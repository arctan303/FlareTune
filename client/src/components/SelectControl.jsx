import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

const textOf = (children) => React.Children.toArray(children).map((child) =>
  React.isValidElement(child) ? textOf(child.props.children) : String(child)).join('');

const optionsOf = (children) => React.Children.toArray(children).flatMap((child) => {
  if (!React.isValidElement(child)) return [];
  if (child.type !== 'option') return optionsOf(child.props.children);
  return [{ value: String(child.props.value ?? textOf(child.props.children)),
    label: child.props.children, text: textOf(child.props.children), disabled: Boolean(child.props.disabled) }];
});

// Keeps the existing select callers and form values while sharing the visible UI.
export default function SelectControl({ children, value, defaultValue, onChange, disabled,
  className = '', name, id, form, 'aria-label': label, 'aria-labelledby': labelledBy }) {
  const options = optionsOf(children);
  const [localValue, setLocalValue] = React.useState(defaultValue ?? options[0]?.value ?? '');
  const selectedValue = String(value ?? localValue);
  const selectedIndex = options.findIndex((option) => option.value === selectedValue);
  const selected = options[selectedIndex] || options[0];
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState(null);
  const trigger = React.useRef(null);
  const menu = React.useRef(null);
  const search = React.useRef({ text: '', time: 0 });
  const listId = React.useId();

  React.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const anchor = trigger.current;
    const rect = anchor.getBoundingClientRect();
    const height = Math.min(280, Math.max(100, window.innerHeight - 24));
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const upward = below < Math.min(height, options.length * 44 + 12) && above > below;
    const maxHeight = Math.min(height, Math.max(44, upward ? above : below));
    const width = Math.min(Math.max(rect.width, 192), window.innerWidth - 24);
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      width, maxHeight, ...(upward ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    const outside = (event) => {
      if (!anchor.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    const scroll = (event) => { if (!menu.current?.contains(event.target)) setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, options.length]);
  React.useEffect(() => {
    if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const show = () => {
    if (disabled || !options.some((option) => !option.disabled)) return;
    setActive(selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex : options.findIndex((option) => !option.disabled));
    search.current = { text: '', time: 0 };
    setOpen(true);
  };
  const choose = (index) => {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    setOpen(false);
    setLocalValue(option.value);
    if (option.value !== selectedValue) onChange?.({ target: { value: option.value, name },
      currentTarget: { value: option.value, name } });
    trigger.current?.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); return;
    }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault(); if (open) choose(active); else show(); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); return; }
      const indices = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
      const current = indices.indexOf(active);
      setActive(event.key === 'Home' ? indices[0] : event.key === 'End' ? indices.at(-1)
        : indices[(current + (event.key === 'ArrowDown' ? 1 : -1) + indices.length) % indices.length]);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const query = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase();
      search.current = { text: query, time: now };
      const index = options.findIndex((option) => !option.disabled && option.text.toLocaleLowerCase().startsWith(query));
      if (!open) show();
      if (index >= 0) setActive(index);
    }
  };

  return <span className={`select-control ${className}`}>
    {name && <input type="hidden" name={name} form={form} disabled={disabled} value={selected?.value ?? ''} />}
    <button ref={trigger} id={id} type="button" role="combobox" disabled={disabled}
      aria-label={label} aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={listId} aria-activedescendant={open ? `${listId}-${active}` : undefined}
      className="select-control__trigger" onKeyDown={onKeyDown}
      onBlur={(event) => { if (!menu.current?.contains(event.relatedTarget)) setOpen(false); }}
      onClick={() => open ? setOpen(false) : show()}>
      <span className="select-control__value">{selected?.label}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && position && createPortal(<div ref={menu} id={listId} role="listbox" aria-label={label}
      className="select-control__menu" style={position}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option"
        aria-selected={option.value === selectedValue} aria-disabled={option.disabled || undefined}
        data-index={index} data-active={index === active} className="select-control__option"
        onMouseDown={(event) => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); choose(index); }}>
        <span>{option.label}</span>{option.value === selectedValue && <Check size={16} aria-hidden="true" />}
      </div>)}
    </div>, trigger.current.closest('dialog') || document.body)}
  </span>;
}
