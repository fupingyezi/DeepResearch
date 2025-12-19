export const Title: React.FC<{ title: string; className?: string }> = ({
  title,
  className,
}) => {
  return (
    <div className={`font-semibold text-gray-800 ${className}`}>{title}</div>
  );
};
