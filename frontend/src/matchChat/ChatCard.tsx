import { useEffect, useRef, useState } from 'react';
import type { Player } from '../../../shared/src/game/types';
import { PLAYERS } from '../../../shared/src/game/types';
import { colorName } from '../playerPresentation';
import { EMOJIS, STICKERS, type ChatMessage, type ChatTransport, type MatchModel } from './catalog';

interface ChatCardProps {
  model: MatchModel;
  messages: ChatMessage[];
  transport: ChatTransport;
  localSeat?: Player;
  onLocalSeatChange?: (seat: Player) => void;
  banterEnabled?: boolean;
  onBanterChange?: (enabled: boolean) => void;
  onReport?: (messageId: string) => void;
}

interface RewritePreview {
  original: string;
  text: string;
  mode: string;
}

export function ChatCard({
  model,
  messages,
  transport,
  localSeat,
  onLocalSeatChange,
  banterEnabled = true,
  onBanterChange,
  onReport,
}: ChatCardProps) {
  const humanSeats = PLAYERS.filter((seat) => model.players[seat].kind === 'human');
  const activeSeat = model.mode === 'local' && humanSeats.length > 1
    ? (localSeat ?? humanSeats[0])
    : (model.mySeat ?? humanSeats[0] ?? 'A');
  const seatName = model.players[activeSeat]?.name ?? activeSeat;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [rewriteEnabled, setRewriteEnabled] = useState(false);
  const [style, setStyle] = useState('meme');
  const [preview, setPreview] = useState<RewritePreview | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const historyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPreview(null);
    setText('');
    setPickerOpen(false);
  }, [model.roomId]);

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [messages.length]);

  async function sendText(rawText: string, rewritten = false) {
    if (!rawText.trim() || busy) return;
    setBusy(true);
    try {
      await transport.send({
        kind: 'text',
        text: rawText,
        rewritten,
        clientMessageId: crypto.randomUUID(),
      }, { roomId: model.roomId, localSeat: activeSeat });
      setText('');
      setPreview(null);
      setNotice(model.environment === 'website' ? '消息已发送' : '本地消息已加入');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '消息未发送');
    } finally {
      setBusy(false);
    }
  }

  async function sendSticker(stickerId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await transport.send({
        kind: 'sticker',
        stickerId,
        clientMessageId: crypto.randomUUID(),
      }, { roomId: model.roomId, localSeat: activeSeat });
      setPickerOpen(false);
      setNotice('贴纸已发送');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '贴纸未发送');
    } finally {
      setBusy(false);
    }
  }

  async function submitText() {
    const raw = text.trim();
    if (!raw || busy) return;
    if (!rewriteEnabled) {
      await sendText(raw, false);
      return;
    }
    setBusy(true);
    try {
      const result = await transport.rewrite({ text: raw, style });
      setPreview({ original: raw, text: result.text, mode: result.mode });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '改写失败，可发送原文');
      setPreview({ original: raw, text: raw, mode: 'ORIGINAL_FALLBACK' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="match-chat-card" aria-label="三位玩家和局内聊天">
      <div className="chat-seat-row">
        {PLAYERS.map((seat) => {
          const player = model.players[seat];
          const active = !model.ended && seat === model.turn;
          const mine = seat === activeSeat && player.kind === 'human';
          return (
            <div key={seat} className={`chat-seat ${active ? 'active' : ''} ${mine ? 'mine' : ''}`}>
              <span className={`seat-stone seat-${seat.toLowerCase()}`}>{seat}</span>
              <div className="seat-info">
                <strong>{player.name}</strong>
                <small>{player.kind === 'ai' ? 'AI' : '真人'}</small>
              </div>
              {active && <span className="seat-turn">落子</span>}
            </div>
          );
        })}
      </div>

      <div className="chat-history-panel">
        <header>
          <h2>{'局内聊天'}</h2>
          <small>{model.ended ? '本局已结束 · 记录保留' : '仅本局三席可见'}</small>
        </header>
        <div className="chat-history" role="log" aria-live="polite" ref={historyRef}>
          {messages.length === 0 && <p className="chat-empty">本局还没有消息。</p>}
          {messages.map((message) => (
            <article key={message.id} className={`chat-message ${message.seat}`}>
              <span className={`seat-stone small seat-${message.seat.toLowerCase()}`}>{message.seat}</span>
              <div>
                <header>
                  <strong>{message.name}</strong>
                  <span>{message.authorKind === 'ai' ? 'AI' : '真人'}</span>
                  {message.rewritten && <span className="rewrite-badge">改写</span>}
                  <time>{new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                </header>
                {message.kind === 'sticker'
                  ? (
                      <div className="chat-sticker">
                        <b>{STICKERS.find((s) => s.id === message.stickerId)?.emoji ?? '🙂'}</b>
                        <span>{STICKERS.find((s) => s.id === message.stickerId)?.text ?? message.stickerId}</span>
                      </div>
                    )
                  : <p>{message.text}</p>}
                {message.authorKind === 'human' && onReport && (
                  <button type="button" className="report" onClick={() => onReport(message.id)}>举报</button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="chat-settings">
        {model.mode === 'local' && humanSeats.length > 1 && onLocalSeatChange && (
          <label>
            <span>发言席位</span>
            <select value={activeSeat} onChange={(event) => onLocalSeatChange(event.target.value as Player)}>
              {humanSeats.map((seat) => <option key={seat} value={seat}>{colorName(seat)}</option>)}
            </select>
          </label>
        )}
        <label>
          <input type="checkbox" checked={rewriteEnabled} onChange={(event) => {
            setRewriteEnabled(event.target.checked);
            setPreview(null);
          }}/>
          趣味改写
        </label>
        {rewriteEnabled && (
          <select value={style} onChange={(event) => setStyle(event.target.value)} aria-label="表达风格">
            <option value="meme">网络趣味</option>
            <option value="wuxia">武侠切磋</option>
            <option value="english">English banter</option>
          </select>
        )}
        <label>
          <input
            type="checkbox"
            checked={banterEnabled}
            onChange={(event) => onBanterChange?.(event.target.checked)}
          />
          AI 台词
        </label>
      </div>

      {preview && (
        <div className="rewrite-preview" role="status">
          <strong>发送前预览</strong>
          <p>{preview.text}</p>
          <div className="rewrite-actions">
            <button type="button" disabled={busy} onClick={() => void sendText(preview.text, preview.mode === 'MODEL_REWRITE')}>确认发送</button>
            <button type="button" disabled={busy} onClick={() => void sendText(preview.original, false)}>发送原文</button>
            <button type="button" onClick={() => setPreview(null)}>取消</button>
          </div>
          <small>{preview.mode === 'MODEL_REWRITE' ? '模型改写结果' : '模型不可用，原文可用'}</small>
        </div>
      )}

      {pickerOpen && (
        <div className="emoji-picker">
          <div className="emoji-row">
            {EMOJIS.map((emoji) => (
              <button key={emoji} type="button" onClick={() => setText((current) => current + emoji)}>{emoji}</button>
            ))}
          </div>
          <div className="sticker-row">
            {STICKERS.map((sticker) => (
              <button key={sticker.id} type="button" onClick={() => void sendSticker(sticker.id)}>
                <b>{sticker.emoji}</b>
                <span>{sticker.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <form className="chat-composer" onSubmit={(event) => {
        event.preventDefault();
        void submitText();
      }}>
        <button
          type="button"
          aria-expanded={pickerOpen}
          aria-label="表情与原创贴纸"
          onClick={() => setPickerOpen((open) => !open)}
        >
          ☺
        </button>
        <textarea
          rows={1}
          maxLength={280}
          value={text}
          placeholder="输入消息… Enter 发送，Shift+Enter 换行"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submitText();
            }
          }}
        />
        <button type="submit" className="chat-send" disabled={busy}>发送</button>
      </form>
      <div className="composer-foot">
        <span>{notice || `以 ${seatName} 发送 · 改写需预览确认`}</span>
      </div>
    </section>
  );
}
