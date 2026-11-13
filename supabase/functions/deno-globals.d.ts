declare namespace Deno {
  namespace env {
    function get(key: string): string | undefined;
  }
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}

declare module 'npm:@supabase/supabase-js@2';
declare module 'npm:xlsx@0.18.5';
