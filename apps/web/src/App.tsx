import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoadingBlock } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Forms from './pages/Forms';
import Quality from './pages/Quality';
import Admin from './pages/Admin';
import Assistant from './pages/Assistant';
import { ProjectDetail, ProjectsList } from './pages/Projects';
import { CompaniesList, CompanyDetail, LeadsList, OpportunitiesList, OpportunityDetail } from './pages/Crm';
import { BriefDetail, BriefsList, ProposalDetail, ProposalsList } from './pages/Sales';
import {
  ChangeDetail, ChangesList, TaskDetail, TasksList, Traffic, WorkOrderDetail, WorkOrdersList,
} from './pages/Operations';
import { ContractDetail, ContractsList, Finance } from './pages/Commercial';

// Reports pulls in the charting library; loading it on demand keeps first paint light.
const Reports = lazy(() => import('./pages/Reports'));

/** Renders `element` only when the user holds `permission`; otherwise sends them home. */
function Guarded({ permission, element }: { permission: string; element: React.ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{element}</> : <Navigate to="/" replace />;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingBlock label="در حال آماده‌سازی…" />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Shell>
      <Suspense fallback={<LoadingBlock />}>
      <ErrorBoundary>
        <Routes>
        <Route path="/" element={<Dashboard />} />

        <Route path="/leads" element={<Guarded permission="crm.lead.read" element={<LeadsList />} />} />
        <Route path="/opportunities" element={<Guarded permission="crm.opportunity.read" element={<OpportunitiesList />} />} />
        <Route path="/opportunities/:id" element={<Guarded permission="crm.opportunity.read" element={<OpportunityDetail />} />} />
        <Route path="/companies" element={<Guarded permission="crm.company.read" element={<CompaniesList />} />} />
        <Route path="/companies/:id" element={<Guarded permission="crm.company.read" element={<CompanyDetail />} />} />

        <Route path="/briefs" element={<Guarded permission="brief.read" element={<BriefsList />} />} />
        <Route path="/briefs/:id" element={<Guarded permission="brief.read" element={<BriefDetail />} />} />
        <Route path="/proposals" element={<Guarded permission="proposal.read" element={<ProposalsList />} />} />
        <Route path="/proposals/:id" element={<Guarded permission="proposal.read" element={<ProposalDetail />} />} />

        <Route path="/projects" element={<Guarded permission="project.read" element={<ProjectsList />} />} />
        <Route path="/projects/:id" element={<Guarded permission="project.read" element={<ProjectDetail />} />} />
        <Route path="/work-orders" element={<Guarded permission="workorder.read" element={<WorkOrdersList />} />} />
        <Route path="/work-orders/:id" element={<Guarded permission="workorder.read" element={<WorkOrderDetail />} />} />
        <Route path="/tasks" element={<Guarded permission="task.read" element={<TasksList />} />} />
        <Route path="/tasks/:id" element={<Guarded permission="task.read" element={<TaskDetail />} />} />

        <Route path="/qc" element={<Guarded permission="qc.read" element={<Quality />} />} />
        <Route path="/changes" element={<Guarded permission="change.read" element={<ChangesList />} />} />
        <Route path="/changes/:id" element={<Guarded permission="change.read" element={<ChangeDetail />} />} />
        <Route path="/traffic" element={<Guarded permission="traffic.read" element={<Traffic />} />} />

        <Route path="/contracts" element={<Guarded permission="contract.read" element={<ContractsList />} />} />
        <Route path="/contracts/:id" element={<Guarded permission="contract.read" element={<ContractDetail />} />} />
        <Route path="/finance" element={<Guarded permission="finance.read" element={<Finance />} />} />

        <Route path="/forms" element={<Guarded permission="form.read" element={<Forms />} />} />
        <Route path="/reports" element={<Guarded permission="report.read" element={<Reports />} />} />
        <Route path="/ai" element={<Guarded permission="ai.use" element={<Assistant />} />} />
        <Route path="/admin" element={<Guarded permission="admin.audit" element={<Admin />} />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </ErrorBoundary>
      </Suspense>
    </Shell>
  );
}
