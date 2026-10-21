import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EU & Norwegian Cyber and AI Regulation Assistant',
  description:
    'Ask questions about EU and Norwegian cybersecurity and AI regulation, including the CRA, the AI Act and digitalsikkerhetsloven, with cited sources.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
