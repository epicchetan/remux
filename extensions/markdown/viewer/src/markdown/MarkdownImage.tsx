import { readFileDataUrl } from '@remux/extension-api/fs';
import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react';

type MarkdownImageProps = ComponentPropsWithoutRef<'img'> & {
  filePath: string;
};

type ImageSource =
  | { kind: 'empty' }
  | { kind: 'local'; path: string }
  | { kind: 'remote'; src: string };

type ImageState =
  | { status: 'failed'; message: string }
  | { status: 'loading'; message: string }
  | { src: string; status: 'ready' };

export function MarkdownImage({
  alt,
  filePath,
  src,
  ...props
}: MarkdownImageProps) {
  const imageSource = useMemo(() => imageSourceFromSrc(src, filePath), [filePath, src]);
  const [state, setState] = useState<ImageState>(() => stateFromImageSource(imageSource));

  useEffect(() => {
    let cancelled = false;

    if (imageSource.kind !== 'local') {
      setState(stateFromImageSource(imageSource));
      return;
    }

    setState({
      message: 'Loading image',
      status: 'loading',
    });

    readFileDataUrl(imageSource.path)
      .then((dataUrl) => {
        if (!cancelled) {
          setState({
            src: dataUrl,
            status: 'ready',
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            message: error instanceof Error && error.message.includes('too large')
              ? 'Image is too large'
              : 'Image unavailable',
            status: 'failed',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [imageSource]);

  if (state.status !== 'ready') {
    return (
      <ImagePlaceholder
        alt={alt}
        message={state.message}
      />
    );
  }

  return (
    <img
      alt={alt ?? ''}
      loading="lazy"
      onError={() => {
        setState({
          message: 'Image unavailable',
          status: 'failed',
        });
      }}
      src={state.src}
      {...props}
    />
  );
}

function ImagePlaceholder({
  alt,
  message,
}: {
  alt: string | undefined;
  message: string;
}) {
  return (
    <span className="remux-markdown-image-placeholder">
      <span className="remux-markdown-image-placeholder-title">
        {message}
      </span>
      {alt ? (
        <span className="remux-markdown-image-placeholder-alt">
          {alt}
        </span>
      ) : null}
    </span>
  );
}

function stateFromImageSource(imageSource: ImageSource): ImageState {
  switch (imageSource.kind) {
    case 'empty':
      return {
        message: 'Image unavailable',
        status: 'failed',
      };
    case 'local':
      return {
        message: 'Loading image',
        status: 'loading',
      };
    case 'remote':
      return {
        src: imageSource.src,
        status: 'ready',
      };
  }
}

function imageSourceFromSrc(src: string | undefined, filePath: string): ImageSource {
  if (!src) {
    return { kind: 'empty' };
  }

  const normalizedRemoteSrc = normalizeRemoteImageSrc(src);
  if (normalizedRemoteSrc) {
    return { kind: 'remote', src: normalizedRemoteSrc };
  }

  if (src.startsWith('//')) {
    return { kind: 'remote', src: `https:${src}` };
  }

  const pathPart = src.split(/[?#]/u, 1)[0];
  if (!pathPart) {
    return { kind: 'empty' };
  }

  const decodedPath = decodePathPart(pathPart);
  return {
    kind: 'local',
    path: decodedPath.startsWith('/')
      ? decodedPath
      : normalizePath(`${dirname(filePath)}/${decodedPath}`),
  };
}

function normalizeRemoteImageSrc(src: string) {
  if (/^(?:data:|blob:)/iu.test(src)) {
    return src;
  }

  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  if (url.hostname === 'github.com') {
    const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/u.exec(url.pathname);
    if (match) {
      const [, owner, repo, ref, file] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`;
    }
  }

  return src;
}

function decodePathPart(pathPart: string) {
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function dirname(filePath: string) {
  const normalized = filePath.replace(/\/+$/u, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '/';
}

function normalizePath(filePath: string) {
  const absolute = filePath.startsWith('/');
  const parts = filePath.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      stack.pop();
      continue;
    }

    stack.push(part);
  }

  return `${absolute ? '/' : ''}${stack.join('/')}`;
}
