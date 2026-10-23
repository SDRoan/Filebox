/**
 * Files for the File Box AI accuracy test set. Names deliberately do not say what the files are,
 * so File Box AI has to read them. "owner" is the person asking; "other" is a different account.
 */
const filler = 'The quarterly operations review covered staffing, shipping volumes, supplier terms and maintenance schedules across all regional sites. ';

module.exports = {
  users: ['owner', 'other'],
  files: [
    {
      owner: 'owner',
      name: 'doc1.txt',
      text: 'Metro Electric\nAccount holder: Jordan Lee\nAccount number: 4471-2209\nBilling period: Sep 1 - Sep 30, 2026\nElectricity used: 412 kWh\nAmount due: $84.20\nDue date: October 21, 2026',
    },
    {
      owner: 'owner',
      name: 'scan_0042.txt',
      text: 'State University - Official Academic Transcript\nStudent: Jordan Lee\nFall 2025\n  MATH 221 Calculus I ........ A-\n  PHYS 101 Physics I .......... B+\n  ENGL 110 Composition ........ A\nSpring 2026\n  MATH 222 Calculus II ....... B\n  CS 150 Programming .......... A\nCumulative GPA: 3.62',
    },
    {
      owner: 'owner',
      name: 'hw3.txt',
      text: 'MATH 221 - Homework 3\nName: Jordan Lee\nDue: Friday, September 19\n1. Find the derivative of f(x) = x^2 sin(x).\n2. Evaluate the limit of (sin x)/x as x approaches 0.\n3. Show all work for full credit.',
    },
    {
      owner: 'owner',
      name: 'file (2).txt',
      text: 'CERTIFICATE OF COMPLETION\nThis certifies that Jordan Lee has successfully completed\nAWS Cloud Practitioner Essentials\nIssued on March 3, 2026\nCertificate ID: AWS-77812',
    },
    {
      owner: 'owner',
      name: 'notes.txt',
      text: 'Q4 planning meeting - October 2, 2026\nAttendees: Priya, Omar, Jordan\nDecisions:\n- Product launch moved to November 14\n- Priya owns the budget review\n- Hosting costs must drop 20% before January',
    },
    {
      owner: 'owner',
      name: 'SR profile.txt',
      text: 'Jordan Lee. Education: BSc Computer Science, State University, 2026. Experience: Software Engineering Intern at Acme (Summer 2025). Skills: Python, TypeScript, React, SQL.',
    },
    {
      owner: 'owner',
      name: 'Startup Ideas.txt',
      text: 'Idea 7: AI resume screening for hiring teams. Idea 8: a meal planner for students. Idea 9: invoice tracking for freelancers.',
    },
    {
      owner: 'owner',
      name: 'IMG_0419.txt',
      text: 'TARGET Store #1182\n04/19/2026 3:42 PM\nUSB-C cable 12.99\nNotebook 3-pack 6.49\nDish soap 3.79\nSubtotal 23.27\nTax 2.06\nTOTAL 25.33\nVISA ****4421',
    },
    {
      owner: 'owner',
      name: 'apt.txt',
      text: 'RESIDENTIAL LEASE AGREEMENT\nTenant: Jordan Lee\nLandlord: Harbor Properties LLC\nPremises: 22 Elm Street, Apt 4B\nMonthly rent: $1,850, due on the 1st of each month\nLease term: September 1, 2026 to August 31, 2027\nSecurity deposit: $1,850',
    },
    {
      owner: 'owner',
      name: 'ops-report.txt',
      text: `${filler.repeat(120)}\nFacilities: the warehouse lease ends on 31 January 2027, and renewal talks start in November.\n${filler.repeat(120)}`,
    },
    {
      owner: 'other',
      name: 'bill.txt',
      text: 'City Water Department\nAccount holder: Sam Patel\nAmount due: $61.75\nDue date: November 2, 2026',
    },
  ],
};
