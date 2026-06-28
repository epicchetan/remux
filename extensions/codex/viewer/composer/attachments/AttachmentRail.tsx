import { useEffect, useState } from 'react';
import { ImageIcon, Loader2, X } from 'lucide-react';

import { FileTypeIcon } from '../../transcript/components/file/fileTypeIcons';
import type { ComposerAttachmentView } from '../model/composerModel';

export function ComposerAttachmentRail({
  attachments,
  disabled = false,
  onRemoveAttachment,
}: {
  attachments: ComposerAttachmentView[];
  disabled?: boolean;
  onRemoveAttachment: (id: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="remux-composer-top-rail">
      {attachments.map((attachment) => (
        <ComposerAttachmentCard
          attachment={attachment}
          disabled={disabled}
          key={attachment.id}
          onRemove={() => onRemoveAttachment(attachment.id)}
        />
      ))}
    </div>
  );
}

function ComposerAttachmentCard({
  attachment,
  disabled,
  onRemove,
}: {
  attachment: ComposerAttachmentView;
  disabled: boolean;
  onRemove: () => void;
}) {
  const imagePreviewUrl = attachment.previewUrl ?? attachment.dataUrl;
  const isImage = Boolean(imagePreviewUrl && attachment.mimeType?.startsWith('image/'));
  const imageState = attachment.error ? 'error' : attachment.dataUrl ? 'ready' : 'pending';

  return (
    <div className="remux-composer-attachment-card" data-image-state={imageState}>
      <div className="remux-composer-attachment-thumb">
        {isImage && imagePreviewUrl ? (
          <img alt="" className="remux-composer-attachment-img" src={imagePreviewUrl} />
        ) : attachment.mimeType?.startsWith('image/') ? (
          <ImageIcon className="size-5" />
        ) : (
          <FileTypeIcon extension={fileExtensionFromName(attachment.name)} fileName={attachment.name} />
        )}
      </div>
      <div className="remux-composer-reference-card-copy">
        <MeasuredAttachmentName className="remux-composer-reference-card-name" name={attachment.name} />
        <div className="remux-composer-reference-card-subtitle">
          {attachment.error ?? (attachment.dataUrl ? attachment.mimeType || 'Image' : 'Reading image')}
        </div>
      </div>
      {!attachment.dataUrl && !attachment.error ? (
        <Loader2 className="remux-composer-attachment-status size-3.5 animate-spin" />
      ) : null}
      <button
        aria-label={`Remove ${attachment.name}`}
        className="remux-composer-card-remove"
        data-remux-no-composer-focus
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          if (disabled) {
            return;
          }
          onRemove();
        }}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function MeasuredAttachmentName({
  className,
  name,
}: {
  className: string;
  name: string;
}) {
  const label = useMeasuredAttachmentLabel(name);

  return (
    <div className={className} ref={label.ref} title={name}>
      {label.text}
    </div>
  );
}

function useMeasuredAttachmentLabel(name: string) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [text, setText] = useState(name);

  useEffect(() => {
    if (!element) {
      setText(name);
      return;
    }

    const measuredElement = element;

    function updateText() {
      const width = measuredElement.getBoundingClientRect().width;
      setText(compactMiddle(name, Math.max(8, Math.floor(width / 8))));
    }

    updateText();

    const resizeObserver = new ResizeObserver(updateText);
    resizeObserver.observe(measuredElement);
    window.addEventListener('resize', updateText);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateText);
    };
  }, [element, name]);

  return {
    ref: setElement,
    text,
  };
}

function compactMiddle(text: string, maxCharacters: number) {
  if (text.length <= maxCharacters) {
    return text;
  }

  const extension = fileExtensionSuffix(text);
  const stem = extension ? text.slice(0, -extension.length) : text;
  const available = Math.max(4, maxCharacters - extension.length - 3);
  const headLength = Math.max(1, Math.ceil(available * 0.58));
  const tailLength = Math.max(1, available - headLength);
  return `${stem.slice(0, headLength)}...${stem.slice(Math.max(0, stem.length - tailLength))}${extension}`;
}

function fileExtensionFromName(fileName: string) {
  const extension = fileName.split('.').pop()?.trim().toLowerCase() ?? '';
  return extension.length > 0 && extension !== fileName.toLowerCase() ? extension : null;
}

function fileExtensionSuffix(fileName: string) {
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return '';
  }

  return fileName.slice(dotIndex);
}
