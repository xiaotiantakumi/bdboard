import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { localFileRawUrl } from '../../api/local-files';
import { LocalMediaViewer } from './LocalMediaViewer';

const TICKET_ID = 'video-p4q.38';
const VIDEO_PATH = 'out/13-demo/reading-review.mp4';
const AUDIO_PATH = 'out/13-demo/reading-review.m4a';

describe('LocalMediaViewer', () => {
  it('renders a video element with controls and the raw url', () => {
    const { container } = render(
      <LocalMediaViewer ticketId={TICKET_ID} path={VIDEO_PATH} kind="video" />,
    );

    const video = container.querySelector('video');
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveAttribute('src', localFileRawUrl(TICKET_ID, VIDEO_PATH));
    expect(video).toHaveClass('local-file-viewer-media');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders an audio element with controls and the raw url', () => {
    const { container } = render(
      <LocalMediaViewer ticketId={TICKET_ID} path={AUDIO_PATH} kind="audio" />,
    );

    const audio = container.querySelector('audio');
    expect(audio).toBeInstanceOf(HTMLAudioElement);
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('preload', 'metadata');
    expect(audio).toHaveAttribute('src', localFileRawUrl(TICKET_ID, AUDIO_PATH));
    expect(container.querySelector('video')).toBeNull();
  });
});
