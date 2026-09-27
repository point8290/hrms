-- 0008 platform reference data: permission catalog and India statutory defaults.
-- Tenant-independent. Re-runnable.

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('tenant.read',            'View tenant configuration', false),
  ('tenant.manage',          'Change tenant configuration', false),
  ('org.read',               'View companies, departments, designations, locations', false),
  ('org.manage',             'Manage organization structure', false),
  ('user.manage',            'Invite and manage users and role assignments', false),
  ('role.manage',            'Create and modify roles', false),
  ('employee.read',          'View employee directory and non-sensitive profile data', false),
  ('employee.read.self',     'View own employee profile', false),
  ('employee.read.team',     'View direct and indirect reports', false),
  ('employee.manage',        'Create and update employees', false),
  ('employee.lifecycle',     'Perform promotion, transfer, confirmation and separation', false),
  ('employee.bank.read',     'View employee bank details', true),
  ('employee.bank.manage',   'Change employee bank details', true),
  ('employee.tax.read',      'View employee tax profile', true),
  ('employee.tax.manage',    'Change employee tax profile', true),
  ('shift.read',             'View shift types and assignments', false),
  ('shift.manage',           'Manage shift types and assignments', false),
  ('attendance.read',        'View attendance for permitted employees', false),
  ('attendance.read.self',   'View own attendance', false),
  ('attendance.checkin',     'Record own check-in', false),
  ('attendance.checkin.other', 'Record check-ins on behalf of employees or devices', false),
  ('attendance.manage',      'Trigger recalculation and manage attendance configuration', false),
  ('attendance.correct',     'Approve or reject attendance corrections', false),
  ('leave.read',             'View leave for permitted employees', false),
  ('leave.read.self',        'View own leave', false),
  ('leave.apply',            'Apply for own leave', false),
  ('leave.approve',          'Approve or reject leave applications', false),
  ('leave.manage',           'Manage leave types, policies and allocations', false),
  ('leave.adjust',           'Post manual leave ledger adjustments', true),
  ('compensation.read',      'View salary structures and assignments', true),
  ('compensation.manage',    'Create and revise compensation', true),
  ('payroll.read',           'View payroll runs and summaries', true),
  ('payroll.run',            'Create and calculate payroll runs', true),
  ('payroll.approve',        'Approve a calculated payroll run', true),
  ('payroll.finalize',       'Finalize payroll and release payslips', true),
  ('payslip.read.self',      'View own payslips', false),
  ('document.read',          'View documents for permitted employees', false),
  ('document.read.self',     'View own documents', false),
  ('document.manage',        'Upload and manage employee documents', false),
  ('workflow.manage',        'Configure approval workflows', false),
  ('audit.read',             'Read the audit trail', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;

-- India statutory defaults (FY 2025-26). Tenant-specific overrides insert their own
-- rows with tenant_id set; nothing here is ever edited once a run has consumed it.
INSERT INTO payroll.statutory_rule
  (tenant_id, country_code, state_code, rule_type, version, effective_from, rule_config)
VALUES
  (NULL, 'IN', NULL, 'pf', 1, DATE '2025-04-01', jsonb_build_object(
     'employee_rate', 0.12,
     'employer_rate', 0.12,
     'wage_ceiling', 15000,
     'apply_ceiling', true,
     'employer_pension_rate', 0.0833,
     'basis_component_codes', jsonb_build_array('BASIC', 'DA')
   )),
  (NULL, 'IN', NULL, 'esi', 1, DATE '2025-04-01', jsonb_build_object(
     'employee_rate', 0.0075,
     'employer_rate', 0.0325,
     'gross_wage_ceiling', 21000
   )),
  (NULL, 'IN', 'KA', 'professional_tax', 1, DATE '2025-04-01', jsonb_build_object(
     'slabs', jsonb_build_array(
       jsonb_build_object('upto', 24999, 'amount', 0),
       jsonb_build_object('upto', NULL, 'amount', 200)
     )
   )),
  (NULL, 'IN', 'MH', 'professional_tax', 1, DATE '2025-04-01', jsonb_build_object(
     'slabs', jsonb_build_array(
       jsonb_build_object('upto', 7500, 'amount', 0),
       jsonb_build_object('upto', 10000, 'amount', 175),
       jsonb_build_object('upto', NULL, 'amount', 200)
     )
   )),
  (NULL, 'IN', NULL, 'income_tax', 1, DATE '2025-04-01', jsonb_build_object(
     'regimes', jsonb_build_object(
       'new', jsonb_build_object(
         'standard_deduction', 75000,
         'rebate_limit', 700000,
         'rebate_max', 25000,
         'cess_rate', 0.04,
         'slabs', jsonb_build_array(
           jsonb_build_object('upto', 300000, 'rate', 0),
           jsonb_build_object('upto', 700000, 'rate', 0.05),
           jsonb_build_object('upto', 1000000, 'rate', 0.10),
           jsonb_build_object('upto', 1200000, 'rate', 0.15),
           jsonb_build_object('upto', 1500000, 'rate', 0.20),
           jsonb_build_object('upto', NULL, 'rate', 0.30)
         )
       ),
       'old', jsonb_build_object(
         'standard_deduction', 50000,
         'rebate_limit', 500000,
         'rebate_max', 12500,
         'cess_rate', 0.04,
         'slabs', jsonb_build_array(
           jsonb_build_object('upto', 250000, 'rate', 0),
           jsonb_build_object('upto', 500000, 'rate', 0.05),
           jsonb_build_object('upto', 1000000, 'rate', 0.20),
           jsonb_build_object('upto', NULL, 'rate', 0.30)
         )
       )
     )
   ))
-- Inference must mirror statutory_rule_version_key exactly (it is an expression index).
ON CONFLICT (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  country_code,
  COALESCE(state_code, '*'),
  rule_type,
  version
) DO NOTHING;
