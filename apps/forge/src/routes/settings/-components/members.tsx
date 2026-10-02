import { can, type User, type UserRole } from "@gitflare/core";
import { Row } from "@gitflare/ui/components/row";
import { Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { accountQueries, useSetMemberRole } from "@/data/account.queries";

const otherRole: Record<UserRole, UserRole> = { admin: "member", member: "admin" };

function MemberRow({ member, mayManage }: { member: User; mayManage: boolean }) {
  const setRole = useSetMemberRole();
  return (
    <Row label={member.name} annotation={member.role} data-testid={`member-${member.id}`}>
      <div className="flex items-center gap-s5">
        <span>{member.email}</span>
        {mayManage && (
          <Button
            variant="outline"
            size="sm"
            disabled={setRole.isPending}
            onClick={() => setRole.mutate({ userId: member.id, role: otherRole[member.role] })}
          >
            Make {otherRole[member.role]}
          </Button>
        )}
      </div>
      {setRole.error && setRole.variables?.userId === member.id && (
        <Text size="detail" className="mt-s2 text-danger" role="alert">
          {setRole.error.message}
        </Text>
      )}
    </Row>
  );
}

/** Who may log in is decided by Access; this is only who may run the deployment. */
export function Members() {
  const { data: members } = useSuspenseQuery(accountQueries.members());
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const mayManage = can(me.user, { type: "members.manage" });
  return (
    <>
      {members.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          mayManage={mayManage && member.id !== me.user.id}
        />
      ))}
      {!mayManage && (
        <Text size="detail" tone="muted" className="mt-s4">
          Only an administrator can change a member's role.
        </Text>
      )}
    </>
  );
}
