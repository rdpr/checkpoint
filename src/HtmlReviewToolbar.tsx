import { Button } from '@plannotator/ui/components/ui/button';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import type { InputMethod } from '@plannotator/ui/types';
import {
  Crosshair,
  MessageSquare,
  Pencil,
  TextSelect,
} from 'lucide-react';

// HtmlViewer owns selections, popovers and persistence payloads. Its current
// contract is comment-only; the general AnnotationToolstrip also offers
// redline, which it has no supported prop to omit.
export function HtmlReviewToolbar({
  armed,
  onArmedChange,
  inputMethod,
  onInputMethodChange,
  mode,
  onModeChange,
}: {
  armed: boolean;
  onArmedChange: (armed: boolean) => void;
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
  mode: 'selection' | 'comment';
  onModeChange: (mode: 'selection' | 'comment') => void;
}) {
  return (
    <div
      className="html-review-tools"
      role="region"
      aria-label="Review tools"
    >
      <div className="html-review-tool-groups">
        <div
          className="html-review-tool-group"
          role="group"
          aria-label="Selection method"
        >
          {(
            [
              ['drag', 'Select', TextSelect],
              ['pinpoint', 'Pinpoint', Crosshair],
            ] as const
          ).map(([value, label, Icon]) => (
            <Button
              key={value}
              size="xs"
              variant="ghost"
              aria-pressed={armed && inputMethod === value}
              iconLeft={<Icon />}
              onClick={() => {
                onArmedChange(true);
                onInputMethodChange(value);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div
          className="html-review-tool-group"
          role="group"
          aria-label="Annotation mode"
        >
          {(
            [
              ['selection', 'Markup', Pencil],
              ['comment', 'Comment', MessageSquare],
            ] as const
          ).map(([value, label, Icon]) => (
            <Button
              key={value}
              size="xs"
              variant="ghost"
              aria-pressed={armed && mode === value}
              iconLeft={<Icon />}
              onClick={() => {
                onArmedChange(true);
                onModeChange(value);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="html-review-interact">
          <HtmlSurfaceControls
            armed={armed}
            onToggleArmed={() => onArmedChange(!armed)}
            labels={{
              annotateLabel: 'Interact with preview',
              interactLabel: 'Annotate preview',
            }}
            shortcuts={{ annotate: null }}
          />
          <span>{armed ? 'Annotating' : 'Interacting'}</span>
        </div>
      </div>
      <p className="html-review-hint">
        {armed
          ? 'Markup offers comment, copy, and Looks good on selected text. Pinpoint opens a comment on an element.'
          : 'Preview controls are active. Choose Select or Pinpoint to resume annotating.'}
      </p>
    </div>
  );
}
