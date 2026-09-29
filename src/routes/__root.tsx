import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, Link, createRootRouteWithContext, useRouter, HeadContent, Scripts } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { AppProvider } from '@/lib/app-context';
import appCss from '../styles.css?url';
import { reportLovableError } from '../lib/lovable-error-reporting';
function NotFoundComponent(){return <div className="flex min-h-screen flex-col items-center justify-center gap-4"><h1 className="page-title text-5xl">404</h1><p>Page not found.</p><Button asChild><Link to="/">Go home</Link></Button></div>}
function ErrorComponent({error,reset}:{error:Error;reset:()=>void}){const router=useRouter();useEffect(()=>{reportLovableError(error,{boundary:'tanstack_root_error_component'})},[error]);return <div className="flex min-h-screen flex-col items-center justify-center gap-4"><h1 className="page-title text-2xl">This page didn’t load</h1><Button onClick={()=>{router.invalidate();reset()}}>Try again</Button></div>}
export const Route=createRootRouteWithContext<{queryClient:QueryClient}>()({head:()=>({meta:[{charSet:'utf-8'},{name:'viewport',content:'width=device-width, initial-scale=1'}],links:[{rel:'stylesheet',href:appCss},{rel:'preconnect',href:'https://fonts.googleapis.com'},{rel:'preconnect',href:'https://fonts.gstatic.com',crossOrigin:'anonymous'},{rel:'stylesheet',href:'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Manrope:wght@500;600;700;800&display=swap'}]}),shellComponent:RootShell,component:RootComponent,notFoundComponent:NotFoundComponent,errorComponent:ErrorComponent});
function RootShell({children}:{children:ReactNode}){return <html lang="en"><head><HeadContent/></head><body>{children}<Scripts/></body></html>}
function RootComponent(){const {queryClient}=Route.useRouteContext();return <QueryClientProvider client={queryClient}><AppProvider><Outlet/></AppProvider><Toaster richColors position="top-right"/></QueryClientProvider>}
