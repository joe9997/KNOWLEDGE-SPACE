import LiquidGlass from 'liquid-glass-react';
import type { ReactNode } from 'react';

const STATIC_MOUSE = { x: 0, y: 0 };

interface LiquidButtonProps {
  children: ReactNode;
  onClick?: () => void;
  width?: number | string;
  height?: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  variant?: 'default' | 'contrast';
}

/**
 * 主按钮：真实液态玻璃折射。
 *
 * 性能与交互处理：
 * - 传入静态 globalMousePos / mouseOffset，关闭库内逐像素 mousemove 与 setState；
 * - elasticity=0，避免跟随鼠标做布局测量；
 * - 最上层放一个真实 button 负责点击与键盘，库内隐藏 SVG 统一 pointer-events:none。
 */
export function LiquidButton({
  children,
  onClick,
  width = 208,
  height = 54,
  disabled = false,
  ariaLabel,
  className = '',
  variant = 'default',
}: LiquidButtonProps) {
  return (
    <div
      className={`liquid-slot ${variant === 'contrast' ? 'liquid-slot--contrast' : ''} ${
        disabled ? 'is-disabled' : ''
      } ${className}`.trim()}
      style={{ width, height }}
      data-liquid-glass="true"
    >
      <LiquidGlass
        className="liquid-glass-root"
        displacementScale={52}
        blurAmount={0.05}
        saturation={132}
        aberrationIntensity={1.6}
        elasticity={0}
        cornerRadius={Math.round(height / 2)}
        padding="0 26px"
        mouseOffset={STATIC_MOUSE}
        globalMousePos={STATIC_MOUSE}
        overLight={false}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: '100%',
          height: '100%',
        }}
      >
        <span className="liquid-glass__label">{children}</span>
      </LiquidGlass>
      <button
        type="button"
        className="liquid-slot__hit"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
      />
    </div>
  );
}
