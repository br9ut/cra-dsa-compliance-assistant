import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CRA & Digital Security Act Assistant',
  description: 'Ask questions about the CRA & Digital Security Act.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
