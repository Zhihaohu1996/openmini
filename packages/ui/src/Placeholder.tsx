export interface PlaceholderProps {
  label: string;
}

export function Placeholder({ label }: PlaceholderProps) {
  return <span data-openmini-ui="placeholder">{label}</span>;
}
