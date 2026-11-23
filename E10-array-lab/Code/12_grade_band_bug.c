#include <stdio.h>

int main(void)
{
    int a[50];
    int n, i;
    int c1 = 0, c2 = 0, c3 = 0;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (i = 0; i < n; i++) {
        if (a[i] >= 0 && a[i] <= 59) {
            c1++;
        } else if (a[i] >= 60 && a[i] <= 79) {
            c2++;
        } else if (a[i] > 80 && a[i] < 100) {
            c3++;
        }
    }

    printf("0-59 分：%d 人\n", c1);
    printf("60-79 分：%d 人\n", c2);
    printf("80-100 分：%d 人\n", c3);
    printf("合计 %d 人\n", c1 + c2 + c3);

    return 0;
}
